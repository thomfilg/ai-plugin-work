// Auto-restart parity tests — ported from the old maestro-conduct.sh
// `restart_eligible` tests onto the JS conduct module.
//
// Acceptance:
//   - `-work` sessions ARE relaunched via `tmux kill-session` + `tmux new-session`
//     running `${CLAUDE_BIN} --dangerously-skip-permissions '/${SKILL_NAME} <tid>'`
//   - `-dev` and `-listen` helper sessions are surfaced informationally but
//     NEVER relaunched as `/work <tid>` (would be wrong: the dev/listen sessions
//     aren't the agent itself).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ACTIONS_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'actions.js');
const CONDUCT_BIN = path.resolve(__dirname, '..', 'maestro-conduct.js');

/**
 * Build a fake `tmux` shim that appends every invocation's argv (one
 * NUL-separated argv per line) to a log file.
 */
function makeFakeTmuxDir(logPath) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tmux-restart-'));
  const script = path.join(dir, 'tmux');
  fs.writeFileSync(
    script,
    `#!/usr/bin/env bash\nprintf '%s\\0' "$@" >> "${logPath}"\nprintf '\\n' >> "${logPath}"\nexit 0\n`,
    { mode: 0o755 }
  );
  return dir;
}

function loadFreshActions(fakeDir, env = {}) {
  delete require.cache[require.resolve(ACTIONS_LIB)];
  // tmux is required transitively, reset it too so it picks up the fake PATH.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct/')) delete require.cache[k];
  }
  Object.assign(process.env, env);
  process.env.PATH = `${fakeDir}:${process.env.PATH}`;
  return require(ACTIONS_LIB);
}

function readInvocations(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => l.split('\0').filter((s) => s.length > 0));
}

test('autoRestart on -work session issues kill-session + new-session', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autorestart-'));
  const logPath = path.join(tmpDir, 'tmux.log');
  const fakeDir = makeFakeTmuxDir(logPath);
  const worktree = path.join(tmpDir, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  const actions = loadFreshActions(fakeDir, {
    CLAUDE_BIN: 'fake-claude',
    SKILL_NAME: 'work',
  });

  const ok = actions.autoRestart({
    session: 'ECHO-5-work',
    ticket: 'ECHO-5',
    worktree,
    silenceSec: 600,
  });
  assert.strictEqual(ok, true, 'autoRestart should succeed');

  const inv = readInvocations(logPath);
  // First call: kill-session -t ECHO-5-work
  assert.deepStrictEqual(inv[0], ['kill-session', '-t', 'ECHO-5-work']);
  // Second call: new-session -d -s ECHO-5-work -c <worktree> '<launcher>'
  assert.strictEqual(inv[1][0], 'new-session');
  assert.deepStrictEqual(inv[1].slice(0, 6), [
    'new-session',
    '-d',
    '-s',
    'ECHO-5-work',
    '-c',
    worktree,
  ]);
  assert.strictEqual(
    inv[1][6],
    "fake-claude --dangerously-skip-permissions '/work ECHO-5'",
    'launcher must match maestro-conduct.sh format'
  );
});

test('autoRestart no-ops when worktree directory is missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autorestart-miss-'));
  const logPath = path.join(tmpDir, 'tmux.log');
  const fakeDir = makeFakeTmuxDir(logPath);
  const actions = loadFreshActions(fakeDir, { CLAUDE_BIN: 'fake-claude' });

  const ok = actions.autoRestart({
    session: 'ECHO-9-work',
    ticket: 'ECHO-9',
    worktree: path.join(tmpDir, 'does-not-exist'),
    silenceSec: 999,
  });
  assert.strictEqual(ok, false, 'autoRestart returns false when worktree absent');
  assert.deepStrictEqual(readInvocations(logPath), []);
});

test('restartEligible: only -work sessions are eligible (helpers skipped)', () => {
  // Smoke-load the conduct script and pull the function via module.exports.
  delete require.cache[require.resolve(CONDUCT_BIN)];
  const conduct = require(CONDUCT_BIN);
  assert.ok(
    typeof conduct.restartEligible === 'function',
    'conduct.js must export restartEligible for downstream tests'
  );
  assert.strictEqual(conduct.restartEligible('ECHO-5-work'), true);
  assert.strictEqual(conduct.restartEligible('ECHO-5-dev'), false);
  assert.strictEqual(conduct.restartEligible('ECHO-5-listen'), false);
  assert.strictEqual(conduct.restartEligible('ECHO-5'), false);
});

// ────────────────────────────────────────────────────────────────────────────
// Integration: drive one conduct.tick() against a fake tmux holding a mix of
// -work + helper sessions, all idle past SILENCE_LIMIT_SEC. Asserts that
// auto-restart fires for -work but NOT for -dev / -listen. This is the parity
// for the old conduct.sh test "discovery surfaces helper sessions but only
// -work is restart-eligible".
// ────────────────────────────────────────────────────────────────────────────

function makeFakeTmuxWithLsAndCapture({ logPath, sessions, pane }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tmux-tick-'));
  const script = path.join(dir, 'tmux');
  const lsLines = sessions.map((s) => `${s}: 1 windows`).join('\n');
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      `printf '%s\\0' "$@" >> "${logPath}"; printf '\\n' >> "${logPath}"`,
      'case "$1" in',
      `  ls) cat <<'EOF'\n${lsLines}\nEOF\n    ;;`,
      `  capture-pane) printf '%s' "${pane.replace(/'/g, "'\\''")}" ;;`,
      '  has-session) exit 0 ;;',
      '  *) ;;',
      'esac',
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 }
  );
  return dir;
}

function reloadConductFresh(env) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct')) delete require.cache[k];
  }
  Object.assign(process.env, env);
  return require(CONDUCT_BIN);
}

function seedStaleSilenceMarker(stateDir, ticket, secAgo, paneText) {
  // Marker must match the current pane snapshot, otherwise silence.detect
  // sees the pane "moved" and resets the marker without firing. We seed the
  // md5 of the pane content the fake tmux will return, with no token change.
  const crypto = require('crypto');
  const hash = crypto
    .createHash('md5')
    .update(paneText || '')
    .digest('hex');
  const now = Math.floor(Date.now() / 1000);
  fs.writeFileSync(
    path.join(stateDir, `${ticket}.silence.json`),
    JSON.stringify({ hash, tokens: null, lastActiveAt: now - secAgo })
  );
}

test('one tick: -work session past SILENCE_LIMIT_SEC IS relaunched', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-work-'));
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir);
  const wtBase = path.join(tmpDir, 'wt');
  fs.mkdirSync(path.join(wtBase, 'fake-repo-ECHO-1'), { recursive: true });
  const logPath = path.join(tmpDir, 'tmux.log');

  // Idle pane: no live spinner, no tokens delta from the stale marker.
  const idlePane = 'idle status bar — no spinner here';
  const fakeDir = makeFakeTmuxWithLsAndCapture({
    logPath,
    sessions: ['ECHO-1-work'],
    pane: idlePane,
  });
  const conduct = reloadConductFresh({
    PATH: `${fakeDir}:${process.env.PATH}`,
    TICKET_PREFIX: 'ECHO',
    STATE_DIR: stateDir,
    WORKTREES_BASE: wtBase,
    REPO_NAME: 'fake-repo',
    CLAUDE_BIN: 'fake-claude',
    SKILL_NAME: 'work',
    SILENCE_LIMIT_SEC: '60',
    LOG_FILE: path.join(tmpDir, 'log'),
  });
  seedStaleSilenceMarker(stateDir, 'ECHO-1', 300, idlePane);

  conduct.tick();

  const inv = readInvocations(logPath);
  const killed = inv.filter((a) => a[0] === 'kill-session' && a.includes('ECHO-1-work'));
  const launched = inv.filter((a) => a[0] === 'new-session' && a.includes('ECHO-1-work'));
  assert.strictEqual(killed.length, 1, 'kill-session must fire for -work');
  assert.strictEqual(launched.length, 1, 'new-session must fire for -work');
});

test('one tick: -listen / -dev helpers past SILENCE_LIMIT_SEC are NOT relaunched', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-helper-'));
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir);
  const wtBase = path.join(tmpDir, 'wt');
  fs.mkdirSync(path.join(wtBase, 'fake-repo-ECHO-2'), { recursive: true });
  fs.mkdirSync(path.join(wtBase, 'fake-repo-ECHO-3'), { recursive: true });
  const logPath = path.join(tmpDir, 'tmux.log');

  const idlePane = 'idle helper pane — no spinner';
  const fakeDir = makeFakeTmuxWithLsAndCapture({
    logPath,
    sessions: ['ECHO-2-listen', 'ECHO-3-dev'],
    pane: idlePane,
  });
  const conduct = reloadConductFresh({
    PATH: `${fakeDir}:${process.env.PATH}`,
    TICKET_PREFIX: 'ECHO',
    STATE_DIR: stateDir,
    WORKTREES_BASE: wtBase,
    REPO_NAME: 'fake-repo',
    CLAUDE_BIN: 'fake-claude',
    SKILL_NAME: 'work',
    SILENCE_LIMIT_SEC: '60',
    LOG_FILE: path.join(tmpDir, 'log'),
  });
  // Helpers are discovered with their bare ticket id (ticketIdFor strips
  // -listen/-dev), so the silence marker is keyed by that.
  seedStaleSilenceMarker(stateDir, 'ECHO-2', 300, idlePane);
  seedStaleSilenceMarker(stateDir, 'ECHO-3', 300, idlePane);

  conduct.tick();

  const inv = readInvocations(logPath);
  const helperKills = inv.filter(
    (a) => a[0] === 'kill-session' && (a.includes('ECHO-2-listen') || a.includes('ECHO-3-dev'))
  );
  const helperLaunches = inv.filter(
    (a) => a[0] === 'new-session' && (a.includes('ECHO-2-listen') || a.includes('ECHO-3-dev'))
  );
  assert.strictEqual(
    helperKills.length,
    0,
    'helper sessions must NEVER be kill-session-ed for relaunch'
  );
  assert.strictEqual(
    helperLaunches.length,
    0,
    'helper sessions must NEVER be new-session-ed (would re-launch as /work, wrong)'
  );
});

test('one tick: mix of -work + -listen — only -work relaunches, helper still discovered', () => {
  // Regression test for the old "discovery surfaces helper sessions but only
  // -work is restart-eligible" contract: a tick with BOTH session types must
  // relaunch -work but neither kill nor relaunch the helper.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tick-mix-'));
  const stateDir = path.join(tmpDir, 'state');
  fs.mkdirSync(stateDir);
  const wtBase = path.join(tmpDir, 'wt');
  fs.mkdirSync(path.join(wtBase, 'fake-repo-ECHO-1'), { recursive: true });
  fs.mkdirSync(path.join(wtBase, 'fake-repo-ECHO-2'), { recursive: true });
  const logPath = path.join(tmpDir, 'tmux.log');

  const fakeDir = makeFakeTmuxWithLsAndCapture({
    logPath,
    sessions: ['ECHO-1-work', 'ECHO-2-listen'],
    pane: 'idle pane',
  });
  const conduct = reloadConductFresh({
    PATH: `${fakeDir}:${process.env.PATH}`,
    TICKET_PREFIX: 'ECHO',
    STATE_DIR: stateDir,
    WORKTREES_BASE: wtBase,
    REPO_NAME: 'fake-repo',
    CLAUDE_BIN: 'fake-claude',
    SKILL_NAME: 'work',
    SILENCE_LIMIT_SEC: '60',
    LOG_FILE: path.join(tmpDir, 'log'),
  });
  seedStaleSilenceMarker(stateDir, 'ECHO-1', 300, 'idle pane');
  seedStaleSilenceMarker(stateDir, 'ECHO-2', 300, 'idle pane');

  conduct.tick();

  const inv = readInvocations(logPath);
  const workKills = inv.filter((a) => a[0] === 'kill-session' && a.includes('ECHO-1-work'));
  const workLaunches = inv.filter((a) => a[0] === 'new-session' && a.includes('ECHO-1-work'));
  const helperKills = inv.filter((a) => a[0] === 'kill-session' && a.includes('ECHO-2-listen'));
  const helperLaunches = inv.filter((a) => a[0] === 'new-session' && a.includes('ECHO-2-listen'));

  assert.strictEqual(workKills.length, 1, '-work must be kill-session-ed exactly once');
  assert.strictEqual(workLaunches.length, 1, '-work must be new-session-ed exactly once');
  assert.strictEqual(helperKills.length, 0, '-listen must NOT be kill-session-ed');
  assert.strictEqual(helperLaunches.length, 0, '-listen must NOT be new-session-ed');
});
