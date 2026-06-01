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
