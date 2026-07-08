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

  it('claude: registers the renderer', async () => {
    const home = freshHome();
    const { code, stdout } = await runInstaller([], { home, runtime: 'claude' });
    assert.equal(code, 0, stdout);
    assert.equal(stdout, `work status bar registered -> ${RENDERER}\n`);
    const settings = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
    assert.deepEqual(settings.statusLine, {
      type: 'command',
      command: RENDERER,
      padding: 0,
      refreshInterval: 3,
    });
  });

  it('claude: chains an existing (e.g. follow-up) bar, --remove restores it', async () => {
    const home = freshHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    fs.writeFileSync(
      settingsPath(home),
      `${JSON.stringify({ statusLine: { type: 'command', command: '/some/followup-statusline.sh' } })}\n`
    );
    await runInstaller([], { home, runtime: 'claude' });
    // chained the prior bar
    const chained = fs.readFileSync(
      path.join(home, '.cache', 'work', 'statusline-chain.cmd'),
      'utf8'
    );
    assert.equal(chained.trim(), '/some/followup-statusline.sh');
    // --remove restores it as the sole bar
    const { stdout } = await runInstaller(['--remove'], { home, runtime: 'claude' });
    assert.equal(stdout, 'work status bar removed — restored /some/followup-statusline.sh\n');
    const settings = JSON.parse(fs.readFileSync(settingsPath(home), 'utf8'));
    assert.equal(settings.statusLine.command, '/some/followup-statusline.sh');
  });
});
