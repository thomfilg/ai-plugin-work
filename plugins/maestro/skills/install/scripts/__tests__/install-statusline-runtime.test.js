/**
 * Runtime guard tests for install-statusline.js (WP-11 C4).
 *
 * Proves, spawning the real CLI with an isolated HOME (never the user's):
 *   - AGENT_RUNTIME=codex ⇒ exit 0, `[maestro:codex-degraded]` refusal with
 *     the tmux status-right alternative, and NO write to
 *     ~/.claude/settings.json — in every mode (default/--print/--remove)
 *   - AGENT_RUNTIME=claude ⇒ byte-identical legacy behavior: registers the
 *     renderer, --remove restores a chained line
 *
 * Run with: node --test install-statusline-runtime.test.js
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALLER = path.join(__dirname, '..', 'install-statusline.js');
const RENDERER = path.join(__dirname, '..', '..', '..', 'lib', 'maestro-statusline.sh');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-statusline-runtime-'));
after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});

let homeSeq = 0;
function freshHome() {
  homeSeq += 1;
  const home = path.join(TMP, `home-${homeSeq}`);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function runInstaller(args, { home, runtime }) {
  // Scrub ambient runtime signals so detectRuntime() sees only what the test
  // pins (CLAUDECODE/CODEX_THREAD_ID leak from the environment running this).
  const env = { ...process.env, HOME: home, AGENT_RUNTIME: runtime };
  delete env.CLAUDECODE;
  delete env.CODEX_THREAD_ID;
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [INSTALLER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

const settingsPath = (home) => path.join(home, '.claude', 'settings.json');

describe('install-statusline runtime guard', () => {
  it('codex: refuses with the degradation notice, exit 0, no settings write', async () => {
    const home = freshHome();
    for (const args of [[], ['--print'], ['--remove']]) {
      const { code, stdout } = await runInstaller(args, { home, runtime: 'codex' });
      assert.equal(code, 0, stdout);
      assert.match(stdout, /^\[maestro:codex-degraded\] statusline unavailable/);
      assert.match(stdout, /tmux set -g status-right/);
      assert.match(stdout, /maestro-alerts\.jsonl/);
    }
    assert.equal(fs.existsSync(settingsPath(home)), false);
  });

  it('claude: registers the renderer exactly as before', async () => {
    const home = freshHome();
    const { code, stdout } = await runInstaller([], { home, runtime: 'claude' });
    assert.equal(code, 0, stdout);
    assert.match(stdout, /^registered maestro status line -> /);
    const settings = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
    assert.deepEqual(settings.statusLine, {
      type: 'command',
      command: path.resolve(RENDERER),
      padding: 0,
      refreshInterval: 3,
    });
  });

  it('claude: --remove restores a chained line', async () => {
    const home = freshHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      settingsPath(home),
      `${JSON.stringify({ statusLine: { type: 'command', command: '/some/other-bar.sh' } })}\n`
    );
    await runInstaller([], { home, runtime: 'claude' });
    const { code, stdout } = await runInstaller(['--remove'], { home, runtime: 'claude' });
    assert.equal(code, 0, stdout);
    assert.match(stdout, /restored chained status line: \/some\/other-bar\.sh/);
    const settings = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
    assert.equal(settings.statusLine.command, '/some/other-bar.sh');
  });
});
