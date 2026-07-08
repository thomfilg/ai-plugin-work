'use strict';

/**
 * Dual-runtime tests for config-detect.js (WP-06) and the config-cli two-leg
 * require.
 *
 * SessionStart must: write the runtime stamp (both runtimes), inject the
 * plugin-root(work-workflow)=… context line on codex ONLY, and emit the
 * config nudge with the configure command rendered per runtime (claude keeps
 * the /work-workflow:configure literal). config-cli must fail with guidance
 * — not a MODULE_NOT_FOUND stack — when the factories escape is absent
 * (cache-isolated install).
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.resolve(__dirname, '..', '..', 'hooks', 'config-detect.js');
const CONFIG_CLI = path.resolve(__dirname, '..', 'config-cli.js');
const PLUGIN_ROOT = path.resolve(__dirname, '..', '..');

function readStamps(home) {
  const dir = path.join(home, '.claude', '.agent-runtime');
  return fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
}

describe('config-detect — dual runtime SessionStart', () => {
  let tmp;
  let home;
  let cwd;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-detect-rt-'));
    home = path.join(tmp, 'home');
    cwd = path.join(tmp, 'cwd');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function runHook(payload, env = {}) {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 15000,
      // Scrubbed env: detection and missing-var math must not depend on the
      // developer's ambient configuration.
      env: { PATH: process.env.PATH, HOME: home, ...env },
    });
    return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  it('claude: stamps the runtime, no plugin-root line, literal configure command', () => {
    const r = runHook(
      {
        session_id: 's-claude',
        cwd,
        transcript_path: '/home/u/.claude/projects/-x/s1.jsonl',
        hook_event_name: 'SessionStart',
        source: 'startup',
      },
      { AGENT_RUNTIME: 'claude' }
    );
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes('plugin-root('), 'plugin-root line is codex-only');
    assert.match(r.stdout, /⚙ work-workflow: \d+ unconfigured config var\(s\)/);
    assert.match(r.stdout, /Run \/work-workflow:configure to set them up/);
    const stamps = readStamps(home);
    assert.equal(stamps.length, 1);
    assert.equal(stamps[0].runtime, 'claude');
    assert.equal(stamps[0].sessionId, 's-claude');
  });

  it('codex: stamps codex, injects plugin-root line, renders the $configure mention', () => {
    const r = runHook(
      {
        session_id: 's-codex',
        cwd,
        transcript_path: '/tmp/h/sessions/2026/07/07/rollout-x.jsonl',
        hook_event_name: 'SessionStart',
        source: 'startup',
      },
      { PLUGIN_ROOT: PLUGIN_ROOT }
    );
    assert.equal(r.code, 0);
    const [firstLine] = r.stdout.split('\n');
    assert.equal(firstLine, `plugin-root(work-workflow)=${PLUGIN_ROOT}`);
    assert.match(r.stdout, /Run the \$configure skill \(work-workflow:configure\) to set them up/);
    const stamps = readStamps(home);
    assert.equal(stamps.length, 1);
    assert.equal(stamps[0].runtime, 'codex');
    assert.equal(stamps[0].sessionId, 's-codex');
  });

  it('fails open on garbage stdin (exit 0)', () => {
    const r = spawnSync(process.execPath, [HOOK], {
      input: '{not json',
      encoding: 'utf8',
      timeout: 15000,
      env: { PATH: process.env.PATH, HOME: home, AGENT_RUNTIME: 'claude' },
    });
    assert.equal(r.status, 0);
  });
});

describe('config-cli — two-leg require', () => {
  it('dev tree: validate runs through factories/envConfig (exit 0)', () => {
    const r = spawnSync(process.execPath, [CONFIG_CLI, 'validate'], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env },
    });
    assert.equal(r.status, 0);
  });

  it('cache install (no factories escape): guidance message, exit 1, no stack trace', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'config-cli-rt-'));
    try {
      const scripts = path.join(tmp, 'plugins', 'work', 'scripts');
      fs.mkdirSync(scripts, { recursive: true });
      fs.copyFileSync(CONFIG_CLI, path.join(scripts, 'config-cli.js'));
      const r = spawnSync(process.execPath, [path.join(scripts, 'config-cli.js'), 'validate'], {
        encoding: 'utf8',
        timeout: 15000,
        env: { ...process.env },
      });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /work config CLI unavailable in this install/);
      assert.doesNotMatch(r.stderr, /Cannot find module/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
