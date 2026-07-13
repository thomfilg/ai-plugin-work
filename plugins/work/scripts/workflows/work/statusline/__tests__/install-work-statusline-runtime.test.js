'use strict';
/**
 * Runtime guard tests for statusline/install-work-statusline.js.
 *
 * Spawns the real CLI with an isolated HOME (never the user's) and proves:
 *   - AGENT_RUNTIME=codex ⇒ exit 0, `[work:codex-degraded]` refusal, and NO
 *     write to ~/.claude/settings.json — in every mode
 *   - AGENT_RUNTIME=claude ⇒ registers the renderer, chains an existing bar,
 *     --remove restores it
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const INSTALLER = path.join(__dirname, '..', 'install-work-statusline.js');
const RENDERER = path.join(__dirname, '..', 'work-statusline.sh');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'work-statusline-runtime-'));
after(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* best-effort */
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
  const env = { ...process.env, HOME: home, AGENT_RUNTIME: runtime };
  delete env.CLAUDECODE;
  delete env.CODEX_THREAD_ID;
  return new Promise((resolve, reject) => {
    const proc = spawn('node', [INSTALLER, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.on('close', (code) => resolve({ code, stdout }));
    proc.on('error', reject);
  });
}

const settingsPath = (home) => path.join(home, '.claude', 'settings.json');

describe('install-work-statusline runtime guard', () => {
  it('codex: refuses with the degradation notice, exit 0, no settings write', async () => {
    const home = freshHome();
    for (const args of [[], ['--print'], ['--remove']]) {
      const { code, stdout } = await runInstaller(args, { home, runtime: 'codex' });
      assert.equal(code, 0, stdout);
      assert.match(stdout, /^\[work:codex-degraded\] statusline unavailable/);
    }
    assert.equal(fs.existsSync(settingsPath(home)), false);
  });

  const hostPath = (home) => path.join(home, '.claude', 'statusline-host.sh');
  const fragPath = (home, name) => path.join(home, '.claude', 'statuslines', name);

  it('claude: installs the shared host and drops the work fragment', async () => {
    const home = freshHome();
    const { code, stdout } = await runInstaller([], { home, runtime: 'claude' });
    assert.equal(code, 0, stdout);
    assert.match(stdout, /^work status bar registered -> /);
    const settings = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
    assert.deepEqual(settings.statusLine, {
      type: 'command',
      command: hostPath(home),
      padding: 0,
      refreshInterval: 3,
    });
    assert.equal(fs.existsSync(hostPath(home)), true);
    assert.equal(fs.readFileSync(fragPath(home, '20-work.cmd'), 'utf8').trim(), RENDERER);
  });

  it('claude: co-exists with a sibling bar; --remove drops only the work fragment', async () => {
    const home = freshHome();
    await runInstaller([], { home, runtime: 'claude' });
    // A sibling bar (e.g. follow-up) registered its own fragment.
    fs.writeFileSync(fragPath(home, '30-followup.cmd'), '/some/followup-statusline.sh\n');
    const { stdout } = await runInstaller(['--remove'], { home, runtime: 'claude' });
    assert.match(stdout, /work status bar removed/);
    assert.equal(fs.existsSync(fragPath(home, '20-work.cmd')), false);
    assert.equal(fs.existsSync(fragPath(home, '30-followup.cmd')), true);
    const settings = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
    assert.equal(settings.statusLine.command, hostPath(home));
  });
});
