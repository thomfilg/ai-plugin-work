// actions.js hardening regressions:
//   1. freeDeadEndSlot holds (no kill) on question-pending when there is no
//      queued work to rotate to — killing gains nothing and destroys context.
//   2. autoRestart skips when the worktree shows fresh progress.
//   3. autoRestart uses `--continue` for generic skills with a resumable
//      conversation (operator directive: relaunch to CONTINUE, never restart
//      a started task from scratch) and fresh `/skill ticket` otherwise.
//   4. maybeAutoBootstrap inherits the manifest command via --skill (GH-626).
//   5. per-skill nudge templates: /work jargon never reaches a generic agent.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ACTIONS_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'actions.js');
const STATE_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'state.js');

function makeFakeBinDir(logPath, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bin-'));
  const mk = (name, body) => {
    // ABSOLUTE interpreter path: `#!/usr/bin/env bash` would resolve through
    // PATH — where our fake `bash` sits first — and recurse forever.
    fs.writeFileSync(
      path.join(dir, name),
      `#!/bin/bash\nprintf '%s\\0' "${name}" "$@" >> "${logPath}"\nprintf '\\n' >> "${logPath}"\n${body || 'exit 0'}\n`,
      { mode: 0o755 }
    );
  };
  mk('tmux', extra.tmux);
  mk('bash', extra.bash);
  return dir;
}

function loadFresh(fakeDir, env = {}) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct/') || k.includes('maestro-cleanup')) delete require.cache[k];
  }
  const isolationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-test-sinks-'));
  Object.assign(
    process.env,
    {
      LOG_FILE: path.join(isolationDir, 'conduct.log'),
      ALERT_FILE: path.join(isolationDir, 'alerts.jsonl'),
      STATE_DIR: path.join(isolationDir, 'state'),
      MAESTRO_SESSION_DIR: path.join(isolationDir, 'sessions'),
      MAESTRO_GROOM_DELAY_SEC: '0',
      MAESTRO_SEND_VERIFY_DELAY_SEC: '0',
      CLAUDE_BIN: 'fake-claude',
    },
    env
  );
  delete process.env.MAESTRO_NS;
  delete process.env.MAESTRO_INBOX_DIR;
  delete process.env.MAESTRO_RESTART_MODE;
  process.env.PATH = `${fakeDir}:${process.env.PATH}`;
  return { actions: require(ACTIONS_LIB), state: require(STATE_LIB) };
}

function invocations(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\0').filter(Boolean));
}

test('freeDeadEndSlot: question-pending with NO eligible next task holds the session', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadend-hold-'));
  const logPath = path.join(tmpDir, 'calls.log');
  const fakeDir = makeFakeBinDir(logPath);
  const { actions } = loadFresh(fakeDir); // empty MAESTRO_SESSION_DIR → no next task

  const killed = actions.freeDeadEndSlot({
    session: 'GH-1-work',
    ticket: 'GH-1',
    kind: 'question-pending',
    repeatCount: 3,
    sha: null,
  });
  assert.equal(killed, false, 'must hold instead of killing');
  const tmuxKills = invocations(logPath).filter((i) => i[0] === 'tmux' && i[1] === 'kill-session');
  assert.equal(tmuxKills.length, 0, 'no tmux kill may be issued');
});

test('freeDeadEndSlot: non-question triggers still rotate', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deadend-rotate-'));
  const logPath = path.join(tmpDir, 'calls.log');
  const fakeDir = makeFakeBinDir(logPath);
  const { actions } = loadFresh(fakeDir);

  const killed = actions.freeDeadEndSlot({
    session: 'GH-2-work',
    ticket: 'GH-2',
    kind: 'nudges-exhausted',
    repeatCount: 3,
    sha: null,
  });
  assert.equal(killed, true);
  const tmuxKills = invocations(logPath).filter((i) => i[0] === 'tmux' && i[1] === 'kill-session');
  assert.ok(tmuxKills.length >= 1, 'rotation must kill the ticket tmux');
});

test('autoRestart: fresh worktree progress suppresses the restart', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-progress-'));
  const logPath = path.join(tmpDir, 'calls.log');
  const fakeDir = makeFakeBinDir(logPath);
  const worktree = path.join(tmpDir, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  const { actions, state } = loadFresh(fakeDir);
  // Simulate a progress marker updated seconds ago.
  state.write('GH-3', 'progress', {
    sig: 'x',
    lastChangeAt: state.now(),
    lastCheckAt: state.now(),
  });

  const ok = actions.autoRestart({
    session: 'GH-3-work',
    ticket: 'GH-3',
    worktree,
    silenceSec: 600,
  });
  assert.equal(ok, false, 'progressing agent must not be restarted');
  assert.equal(invocations(logPath).length, 0, 'no tmux calls while suppressed');
});

test('autoRestart: generic skill with resumable conversation relaunches with --continue', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-continue-'));
  const logPath = path.join(tmpDir, 'calls.log');
  const fakeDir = makeFakeBinDir(logPath);
  const worktree = path.join(tmpDir, 'wt');
  fs.mkdirSync(worktree, { recursive: true });

  const home = path.join(tmpDir, 'home');
  const tasksBase = path.join(tmpDir, 'tasks');
  fs.mkdirSync(path.join(tasksBase, 'GH-4'), { recursive: true });
  fs.writeFileSync(path.join(tasksBase, 'GH-4', '.maestro-skill'), 'qc-work\n');
  // A prior conversation for this worktree (encoded cwd) makes --continue viable.
  const encoded = path.resolve(worktree).replace(/[^A-Za-z0-9-]/g, '-');
  fs.mkdirSync(path.join(home, '.claude', 'projects', encoded), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', encoded, 'x.jsonl'), '{}\n');

  const { actions } = loadFresh(fakeDir, { HOME: home, TASKS_BASE: tasksBase });
  const ok = actions.autoRestart({
    session: 'GH-4-work',
    ticket: 'GH-4',
    worktree,
    silenceSec: 600,
  });
  assert.equal(ok, true);
  const newSession = invocations(logPath).find((i) => i[0] === 'tmux' && i[1] === 'new-session');
  assert.ok(newSession, 'a new tmux session must be created');
  const launch = newSession[newSession.length - 1];
  assert.match(launch, /--continue$/, 'generic skill must resume the conversation');
  assert.doesNotMatch(launch, /\/qc-work GH-4/, 'must not re-run the command from scratch');
});

test('autoRestart: whitelisted skill keeps the fresh /skill relaunch', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-fresh-'));
  const logPath = path.join(tmpDir, 'calls.log');
  const fakeDir = makeFakeBinDir(logPath);
  const worktree = path.join(tmpDir, 'wt');
  fs.mkdirSync(worktree, { recursive: true });
  const tasksBase = path.join(tmpDir, 'tasks');
  fs.mkdirSync(path.join(tasksBase, 'GH-5'), { recursive: true });
  fs.writeFileSync(path.join(tasksBase, 'GH-5', '.maestro-skill'), 'work\n');

  const { actions } = loadFresh(fakeDir, { TASKS_BASE: tasksBase });
  actions.autoRestart({ session: 'GH-5-work', ticket: 'GH-5', worktree, silenceSec: 600 });
  const newSession = invocations(logPath).find((i) => i[0] === 'tmux' && i[1] === 'new-session');
  assert.match(newSession[newSession.length - 1], /'\/work GH-5'$/);
});

test('maybeAutoBootstrap: inherits the manifest command via --skill --allow-generic (GH-626)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-skill-'));
  const logPath = path.join(tmpDir, 'calls.log');
  const fakeDir = makeFakeBinDir(logPath, {
    // tmux ls must list a session so maybeFillPool-style guards see signal;
    // maybeAutoBootstrap itself only needs bash to be intercepted.
    tmux: 'if [ "$1" = "ls" ]; then echo "GH-9-work: 1 windows"; fi\nexit 0',
  });
  const sessionsDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, 'topic.json'),
    JSON.stringify({
      topic: 'topic',
      slots: 4,
      command: 'qc-work',
      createdAt: new Date().toISOString(),
      tasks: [{ id: 'GH-6', priority: 1, deps: [], status: 'pending' }],
    })
  );
  const { actions } = loadFresh(fakeDir, {
    MAESTRO_SESSION_DIR: sessionsDir,
    AUTO_BOOTSTRAP_NEXT: '1',
  });
  const ok = actions.maybeAutoBootstrap
    ? actions.maybeAutoBootstrap('GH-6')
    : (() => {
        // maybeAutoBootstrap is internal; exercise it through freeStopConditionSlot's
        // bootstrap path only if unexported. Fail loudly so the export is added.
        throw new Error('maybeAutoBootstrap must be exported for this regression test');
      })();
  assert.equal(ok, true);
  const bashCall = invocations(logPath).find((i) => i[0] === 'bash');
  assert.ok(bashCall, 'bootstrap must be spawned via bash');
  assert.ok(
    bashCall.includes('--skill=qc-work') && bashCall.includes('--allow-generic'),
    `bootstrap args must inherit the manifest command, got: ${bashCall.join(' ')}`
  );
  assert.equal(bashCall[bashCall.length - 1], 'GH-6');
});

test('nudge templates: generic/follow-up agents never receive /work jargon', () => {
  const rows = require(
    path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'shared', 'skill-registry-rows.js')
  );
  const generic = rows.genericRow().nudge('phase=null stuck 30m', 'soft');
  assert.doesNotMatch(generic, /task-next\.js|commit agent/);
  assert.match(generic, /state the blocker/);

  const followUp = rows.followUpRow().nudge('pr comments stuck', 'interrupt');
  assert.doesNotMatch(followUp, /task-next\.js/);
  assert.match(followUp, /review comments|CI|merge conflicts/);

  const work = rows.workRow().nudge('phase=implement stuck 90m', 'soft');
  assert.match(work, /task-next\.js/, 'work keeps its own vocabulary');
});
