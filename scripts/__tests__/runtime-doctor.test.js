/**
 * Tests for scripts/runtime-doctor.js (WP-11 — packaging/trust doctor CLI)
 *
 * Proves against fixture CODEX_HOMEs (never the real ~/.codex):
 *   - missing config.toml ⇒ every hook untrusted, exit 1, remediation lines
 *   - a fully-trusted config.toml (hashes generated via the doctor lib from
 *     the real hooks.json files) ⇒ exit 0
 *   - a wrong stored hash ⇒ [MODIFIED] entry + the BEST-EFFORT caveat line
 *   - lane-coverage table flags codex-dead tokens (Task/Skill) and marks the
 *     Bash lane live on both runtimes
 *   - --json emits a machine shape with plugins + lanes + gatesOff
 *
 * Run with: node --test scripts/__tests__/runtime-doctor.test.js
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'scripts', 'runtime-doctor.js');
const doctor = require(path.join(REPO_ROOT, 'factories', 'runtime', 'doctor'));

const MARKETPLACE = 'work-workflow';
const PLUGIN_DIRS = {
  'work-workflow': 'plugins/work',
  synapsys: 'plugins/synapsys',
  maestro: 'plugins/maestro',
  heimdall: 'plugins/heimdall',
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-doctor-test-'));
after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

function runCli(args, codexHome) {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [CLI_PATH, '--codex-home', codexHome, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('close', (code) => resolve({ code, stdout, stderr }));
    proc.on('error', reject);
  });
}

function allExpectedEntries() {
  const entries = [];
  for (const [plugin, dir] of Object.entries(PLUGIN_DIRS)) {
    const hooksJson = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, dir, 'hooks', 'hooks.json'), 'utf8')
    );
    entries.push(
      ...doctor.expectedHookEntries(hooksJson, `${plugin}@${MARKETPLACE}:hooks/hooks.json`)
    );
  }
  return entries;
}

function writeCodexHome(name, stateLines) {
  const home = path.join(TMP, name);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), stateLines.join('\n'));
  return home;
}

describe('runtime-doctor CLI', () => {
  it('missing config.toml ⇒ exit 1, all untrusted, remediation printed', async () => {
    const { code, stdout } = await runCli([], path.join(TMP, 'empty-home'));
    assert.equal(code, 1);
    assert.match(stdout, /config\.toml unreadable/);
    assert.match(stdout, /hooks UNTRUSTED — gates are OFF/);
    assert.match(stdout, /--dangerously-bypass-hook-trust/);
    assert.match(stdout, /NEVER script `trusted_hash` writes/);
    // Live-verified TUI trust UX quotes (WP-12, GT §11.2) — operators must be
    // able to recognize the exact pane text the remediation points them at.
    assert.match(stdout, /Hooks need review/);
    assert.match(stdout, /Trust all and continue/);
    assert.match(stdout, /Press t to trust all; enter to review hooks; esc to close/);
    assert.match(stdout, /New hook - review required/);
  });

  it('fully-trusted config.toml ⇒ exit 0', async () => {
    const lines = [];
    for (const entry of allExpectedEntries()) {
      lines.push(`[hooks.state."${entry.key}"]`, `trusted_hash = "${entry.hash}"`, '');
    }
    const home = writeCodexHome('trusted-home', lines);
    const { code, stdout } = await runCli([], home);
    assert.equal(code, 0, stdout);
    assert.match(stdout, /all hooks trusted; nothing to do/);
    assert.doesNotMatch(stdout, /UNTRUSTED\]/);
  });

  it('wrong stored hash ⇒ [MODIFIED] + BEST-EFFORT caveat', async () => {
    const entries = allExpectedEntries();
    const lines = [];
    for (const [i, entry] of entries.entries()) {
      const hash = i === 0 ? 'sha256:0000000000000000000000000000000000000000' : entry.hash;
      lines.push(`[hooks.state."${entry.key}"]`, `trusted_hash = "${hash}"`, '');
    }
    const home = writeCodexHome('modified-home', lines);
    const { code, stdout } = await runCli([], home);
    assert.equal(code, 1);
    assert.match(stdout, /\[MODIFIED\] /);
    assert.match(stdout, /BEST-EFFORT verdict/);
    assert.match(stdout, /not\s+bit-exact-verified/);
  });

  it('lane table flags codex-dead tokens and keeps Bash live on both', async () => {
    const { stdout } = await runCli([], path.join(TMP, 'empty-home'));
    assert.match(stdout, /"Task\|Skill\|Agent" {2}claude=live \(dead tokens: Agent\)/);
    assert.match(stdout, /codex=live \(dead tokens: Task, Skill\)/);
    assert.match(stdout, /"Bash" {2}claude=live {2}codex=live/);
    assert.match(stdout, /UserPromptSubmit\/Stop matchers are IGNORED by codex/);
  });

  it('--json emits plugins + lanes + gatesOff', async () => {
    const { code, stdout } = await runCli(['--json'], path.join(TMP, 'empty-home'));
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.gatesOff, true);
    assert.equal(parsed.plugins.length, 4);
    assert.ok(parsed.lanes.length > 0);
    assert.ok(parsed.lanes.every((lane) => 'claude' in lane && 'codex' in lane));
  });

  it('rejects unknown arguments with exit 2', async () => {
    const { code, stderr } = await runCli(['--bogus'], path.join(TMP, 'empty-home'));
    assert.equal(code, 2);
    assert.match(stderr, /unknown argument/);
  });
});
