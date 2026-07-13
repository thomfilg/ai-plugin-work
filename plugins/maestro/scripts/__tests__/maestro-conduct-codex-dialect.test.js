// WP-09 — conductor-level codex plumbing: ctxFor threads runtime/dialect/
// execLog into every detector ctx, and maybeEscalateToDeadEnd defaults to
// DEAD-END-HOLD for codex TUI sessions (alert/log only — the slot-rotation
// kill path is never reached on pane evidence the conductor cannot read).
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const CONDUCT_BIN = path.resolve(__dirname, '..', 'maestro-conduct.js');

function makeFakeTmux(pane) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-tmux-dialect-'));
  const log = path.join(dir, 'tmux.log');
  fs.writeFileSync(
    path.join(dir, 'tmux'),
    [
      '#!/usr/bin/env bash',
      `printf '%s\\0' "$@" >> "${log}"; printf '\\n' >> "${log}"`,
      'case "$1" in',
      `  capture-pane) printf '%s' '${pane}' ;;`,
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
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct') || k.includes('/lib/runtime/')) delete require.cache[k];
  }
  Object.assign(process.env, env);
  return require(CONDUCT_BIN);
}

function makeEnv() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conduct-dialect-'));
  const { dir: fakeTmuxDir, log: tmuxLog } = makeFakeTmux('some pane content');
  return {
    tmp,
    tmuxLog,
    env: {
      PATH: `${fakeTmuxDir}:${process.env.PATH}`,
      STATE_DIR: path.join(tmp, 'state'),
      TASKS_BASE: path.join(tmp, 'tasks'),
      WORKTREES_BASE: path.join(tmp, 'wt'),
      MAESTRO_SESSION_DIR: path.join(tmp, 'manifests'),
      REPO_NAME: 'fake-repo',
      LOG_FILE: path.join(tmp, 'conduct.log'),
      ALERT_FILE: path.join(tmp, 'alerts.jsonl'),
      TICKET_PREFIX: 'GH',
    },
  };
}

test('ctxFor threads runtime/dialect/execLog (codex ticket, no stream → conservative TUI dialect)', () => {
  const { tmp, env } = makeEnv();
  fs.mkdirSync(path.join(tmp, 'tasks', 'GH-77'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'tasks', 'GH-77', '.maestro-runtime'), 'codex\n');
  const conduct = freshConduct(env);

  const ctx = conduct.ctxFor('GH-77-work');
  assert.equal(ctx.runtime, 'codex');
  assert.equal(ctx.dialect, 'codex-tui-conservative');
  assert.equal(ctx.execLog, path.join(tmp, 'state', 'GH-77.exec.jsonl'));

  // With the teed stream present the dialect flips to exec-json.
  fs.mkdirSync(path.join(tmp, 'state'), { recursive: true });
  fs.writeFileSync(ctx.execLog, '{"type":"thread.started"}\n');
  assert.equal(conduct.ctxFor('GH-77-work').dialect, 'codex-exec-json');

  // A ticket with no runtime anywhere stays claude (byte-identical fleets).
  const claudeCtx = conduct.ctxFor('GH-78-work');
  assert.equal(claudeCtx.runtime, 'claude');
  assert.equal(claudeCtx.dialect, 'claude-tui');
});

test('DEAD-END-HOLD: codex TUI sessions are held (logged), never rotated/killed', () => {
  const { tmp, tmuxLog, env } = makeEnv();
  const conduct = freshConduct(env);
  const ctx = {
    session: 'GH-80-work',
    ticket: 'GH-80',
    phase: 'implement',
    skill: 'work',
    worktree: path.join(tmp, 'wt', 'fake-repo-GH-80'),
    dialect: 'codex-tui-conservative',
  };
  conduct.maybeEscalateToDeadEnd(ctx, 'nudges-exhausted', 5, 'implement');

  const log = fs.readFileSync(env.LOG_FILE, 'utf8');
  assert.match(log, /DEAD-END-HOLD nudges-exhausted ×5 — codex TUI dialect is read-only/);
  // freeDeadEndSlot was never entered: its untracked-ticket bail line is the
  // first thing it logs for a manifest-less ticket, and no kill happened.
  assert.doesNotMatch(log, /DEAD-END skipped/);
  const tmuxCalls = fs.existsSync(tmuxLog) ? fs.readFileSync(tmuxLog, 'utf8') : '';
  assert.doesNotMatch(tmuxCalls, /kill-session/);
});

test('DEAD-END escalation still reaches freeDeadEndSlot for claude sessions (control)', () => {
  const { tmp, env } = makeEnv();
  const conduct = freshConduct(env);
  const ctx = {
    session: 'GH-81-work',
    ticket: 'GH-81',
    phase: 'implement',
    skill: 'work',
    worktree: path.join(tmp, 'wt', 'fake-repo-GH-81'),
    dialect: 'claude-tui',
  };
  conduct.maybeEscalateToDeadEnd(ctx, 'nudges-exhausted', 5, 'implement');
  // The claude path DOES enter freeDeadEndSlot — for this manifest-less
  // ticket that means the untracked-ticket bail line.
  const log = fs.readFileSync(env.LOG_FILE, 'utf8');
  assert.match(log, /DEAD-END skipped — ticket GH-81 not in any manifest/);
});
