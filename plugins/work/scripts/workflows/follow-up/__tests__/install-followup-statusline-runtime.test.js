/**
 * Runtime guard tests for statusline/install-followup-statusline.js (WP-11 C4).
 *
 * Proves, spawning the real CLI with an isolated HOME (never the user's):
 *   - AGENT_RUNTIME=codex ⇒ exit 0, `[work:codex-degraded]` refusal with the
 *     CLI alternative, and NO write to ~/.claude/settings.json — in every
 *     mode (default/--print/--remove)
 *   - AGENT_RUNTIME=claude ⇒ byte-identical legacy behavior: registers the
 *     renderer, chains an existing bar, --remove restores it
 *
 * Run with: node --test install-followup-statusline-runtime.test.js
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALLER = path.join(__dirname, '..', 'statusline', 'install-followup-statusline.js');
const RENDERER = path.join(__dirname, '..', 'statusline', 'followup-statusline.sh');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'followup-statusline-runtime-'));
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

describe('install-followup-statusline runtime guard', () => {
  it('codex: refuses with the degradation notice, exit 0, no settings write', async () => {
    const home = freshHome();
    for (const args of [[], ['--print'], ['--remove']]) {
      const { code, stdout } = await runInstaller(args, { home, runtime: 'codex' });
      assert.equal(code, 0, stdout);
      assert.match(stdout, /^\[work:codex-degraded\] statusline unavailable/);
      assert.match(stdout, /\.follow-up-state\.json/);
    }
    assert.equal(fs.existsSync(settingsPath(home)), false);
  });

  const hostPath = (home) => path.join(home, '.claude', 'statusline-host.sh');
  const fragPath = (home, name) => path.join(home, '.claude', 'statuslines', name);

  it('claude: installs the shared host and drops the follow-up fragment', async () => {
    const home = freshHome();
    const { code, stdout } = await runInstaller([], { home, runtime: 'claude' });
    assert.equal(code, 0, stdout);
    assert.match(stdout, /^follow-up status bar registered -> /);
    // The single slot is the fixed host, not the renderer itself.
    const settings = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
    assert.deepEqual(settings.statusLine, {
      type: 'command',
      command: hostPath(home),
      padding: 0,
      refreshInterval: 3,
    });
    assert.equal(fs.existsSync(hostPath(home)), true);
    assert.ok(fs.statSync(hostPath(home)).mode & 0o111, 'host is executable');
    assert.equal(fs.readFileSync(fragPath(home, '30-followup.cmd'), 'utf8').trim(), RENDERER);
  });

  it('claude: --remove drops only the follow-up fragment, leaving other bars', async () => {
    const home = freshHome();
    await runInstaller([], { home, runtime: 'claude' });
    fs.writeFileSync(fragPath(home, '10-maestro.cmd'), '/some/maestro.sh\n');
    const { code, stdout } = await runInstaller(['--remove'], { home, runtime: 'claude' });
    assert.equal(code, 0, stdout);
    assert.match(stdout, /follow-up status bar removed/);
    assert.equal(fs.existsSync(fragPath(home, '30-followup.cmd')), false);
    assert.equal(fs.existsSync(fragPath(home, '10-maestro.cmd')), true);
    const settings = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
    assert.equal(settings.statusLine.command, hostPath(home));
  });

  it('claude: --remove of the last fragment unregisters the host slot', async () => {
    const home = freshHome();
    await runInstaller([], { home, runtime: 'claude' });
    const { code } = await runInstaller(['--remove'], { home, runtime: 'claude' });
    assert.equal(code, 0);
    const settings = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
    assert.equal(settings.statusLine, undefined);
  });

  it('claude: migrates a pre-existing non-host bar into a fragment (loses nothing)', async () => {
    const home = freshHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      settingsPath(home),
      `${JSON.stringify({ statusLine: { type: 'command', command: '/some/other-bar.sh' } })}\n`
    );
    await runInstaller([], { home, runtime: 'claude' });
    const settings = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
    assert.equal(settings.statusLine.command, hostPath(home));
    assert.equal(
      fs.readFileSync(fragPath(home, '50-preexisting.cmd'), 'utf8').trim(),
      '/some/other-bar.sh'
    );
    assert.equal(fs.existsSync(fragPath(home, '30-followup.cmd')), true);
  });
});
