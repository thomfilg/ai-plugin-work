// End-to-end conductor parity test — ported from the old conduct-e2e.test.js.
//
// Drives ONE tick of maestro-conduct.js against a fake tmux that:
//   - returns a set of ECHO-* sessions for `tmux ls`
//   - returns a fixed pane buffer for `tmux capture-pane`
//
// Asserts:
//   - ECHO-prefix discovery (via TICKET_PREFIX env) finds -work + -dev + -listen
//   - ctxFor derives ticket from session by stripping the maestro suffix
//   - state markers are written into the per-test STATE_DIR (proving the
//     full detector pipeline ran end-to-end through silence + spinner)
//
// The replacement for the .sh's `MAESTRO_MAX_ITERATIONS=N` is just calling
// `conduct.tick()` directly — the JS module exports tick() so callers can
// drive bounded runs without the daemon loop.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const CONDUCT_BIN = path.resolve(__dirname, '..', 'maestro-conduct.js');

function makeFakeTmux({ sessions, pane }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tmux-e2e-'));
  const log = path.join(dir, 'tmux.log');
  const script = path.join(dir, 'tmux');
  const lines = sessions.map((s) => `${s}: 1 windows`).join('\n');
  fs.writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      `printf '%s\\0' "$@" >> "${log}"; printf '\\n' >> "${log}"`,
      'case "$1" in',
      `  ls) cat <<'EOF'\n${lines}\nEOF\n    ;;`,
      `  capture-pane) printf '%s' "${pane.replace(/'/g, "'\\''")}" ;;`,
      '  has-session) exit 0 ;;',
      '  *) ;;',
      'esac',
      'exit 0',
    ].join('\n') + '\n',
    { mode: 0o755 }
  );
  return { dir, log };
}

function freshConduct(env) {
  // Wipe the entire maestro-conduct require subtree so the new env binds.
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct')) delete require.cache[k];
  }
  Object.assign(process.env, env);
  return require(CONDUCT_BIN);
}

test('one tick discovers ECHO -work/-dev/-listen and runs the pipeline', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-state-'));
  const worktreesBase = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-wt-'));

  // Pane shows an active spinner so the silence detector marks the session as
  // active (writes a silence marker) without firing auto-restart.
  const pane = '✻ Jitterbugging… (3s · thinking with medium effort)\n12345 tokens';
  const { dir: fakeTmuxDir } = makeFakeTmux({
    sessions: ['ECHO-1-work', 'ECHO-2-dev', 'ECHO-3-listen', 'unrelated'],
    pane,
  });

  const conduct = freshConduct({
    PATH: `${fakeTmuxDir}:${process.env.PATH}`,
    TICKET_PREFIX: 'ECHO',
    STATE_DIR: stateDir,
    WORKTREES_BASE: worktreesBase,
    REPO_NAME: 'fake-repo',
    // Silence the log spam.
    LOG_FILE: path.join(stateDir, 'log'),
  });

  conduct.tick();

  // Pipeline ran end-to-end. Silence markers are keyed by SESSION (not ticket)
  // so that `-work` + `-dev` + `-listen` helpers sharing a ticket id don't
  // clobber each other's pane-hash markers. state.js writes
  // `<session>.silence.json` per discovered session.
  const sessions = fs
    .readdirSync(stateDir)
    .filter((f) => f.endsWith('.silence.json'))
    .map((f) => f.replace('.silence.json', ''));
  assert.deepStrictEqual(
    sessions.sort(),
    ['ECHO-1-work', 'ECHO-2-dev', 'ECHO-3-listen'].sort(),
    'silence markers must be keyed per session so helpers and the -work pane do not share state'
  );
});

test('ctxFor strips -work / -dev / -listen suffix per session', () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ctx-'));
  const worktreesBase = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-ctx-wt-'));
  const { dir: fakeTmuxDir } = makeFakeTmux({ sessions: [], pane: '' });

  const conduct = freshConduct({
    PATH: `${fakeTmuxDir}:${process.env.PATH}`,
    TICKET_PREFIX: 'ECHO',
    STATE_DIR: stateDir,
    WORKTREES_BASE: worktreesBase,
    REPO_NAME: 'fake-repo',
  });

  assert.strictEqual(conduct.ctxFor('ECHO-5-work').ticket, 'ECHO-5');
  assert.strictEqual(conduct.ctxFor('ECHO-5-dev').ticket, 'ECHO-5');
  assert.strictEqual(conduct.ctxFor('ECHO-5-listen').ticket, 'ECHO-5');
});
