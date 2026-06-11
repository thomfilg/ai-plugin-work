#!/usr/bin/env node
/**
 * stop-guard.js — Stop hook that refuses to end a turn while there are
 * unanswered `action_required: true` alerts from the maestro conductor.
 *
 * Why this exists:
 *   The conductor emits question-pending / nudges-exhausted / pr-broken
 *   alerts with action_required:true and a copy-pasteable `unblockCmd`.
 *   The operator (Claude or human) is supposed to engage. Past failure
 *   mode: the operator replied with "standing by" text and ended the
 *   turn while alerts piled up, eventually burning dead-end attempts.
 *   This hook closes that loop: exit 2 returns stderr to the model's
 *   context, forcing engagement.
 *
 * Auto-wired via plugins/maestro/hooks/hooks.json (Stop matcher: ""). No
 * settings.json edit required — Claude Code picks it up when the maestro
 * plugin is loaded.
 *
 * Behavior:
 *   - Tail last 200 lines of $ALERT_FILE (default /tmp/maestro-alerts.jsonl).
 *   - Find action_required:true alerts newer than the ack marker.
 *   - If any exist, exit 2 with stderr describing the latest pending action
 *     and its literal unblockCmd.
 *   - Acknowledging: after running the unblockCmd (or calling
 *     AskUserQuestion), the operator must touch the state file with the
 *     alert's `ts` ISO string:
 *
 *       node -e "require('fs').writeFileSync('$HOME/.cache/maestro-stop-guard.state', '<ISO-TS>')"
 *
 * Env:
 *   MAESTRO_STOP_GUARD=0        disable for this session
 *   ALERT_FILE                  alert log path (matches alerts.js default)
 *   MAESTRO_STOP_GUARD_STATE    override ack marker location
 *
 * Fail-open: any I/O error → exit 0. Never block when the daemon isn't
 * running or files are missing.
 */
'use strict';
const fs = require('fs');
const path = require('path');

// OPT-IN by default. The conductor session sets MAESTRO_STOP_GUARD=1 when it
// spawns the maestro daemon (via Monitor). Other Claude sessions on the same
// machine — including ones doing totally unrelated work — should NOT be
// blocked from ending turns just because /tmp/maestro-alerts.jsonl exists.
// Previously this hook was opt-out (gated by ==='0'), which fired across
// every Claude session globally and trapped unrelated agents.
if (process.env.MAESTRO_STOP_GUARD !== '1') process.exit(0);

const ALERT_FILE = process.env.ALERT_FILE || '/tmp/maestro-alerts.jsonl';
const STATE_FILE =
  process.env.MAESTRO_STOP_GUARD_STATE ||
  path.join(process.env.HOME || '/tmp', '.cache', 'maestro-stop-guard.state');

if (!fs.existsSync(ALERT_FILE)) process.exit(0);

let lastAckMs = 0;
try {
  const raw = fs.readFileSync(STATE_FILE, 'utf8').trim();
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) lastAckMs = t;
} catch {
  /* missing marker = nothing acked yet */
}

let lines;
try {
  lines = fs.readFileSync(ALERT_FILE, 'utf8').trim().split('\n').slice(-200);
} catch {
  process.exit(0);
}

const pending = [];
for (const line of lines) {
  let a;
  try {
    a = JSON.parse(line);
  } catch {
    continue;
  }
  if (!a || a.action_required !== true) continue;
  const t = Date.parse(a.ts || '');
  if (Number.isNaN(t) || t <= lastAckMs) continue;
  pending.push(a);
}

if (pending.length === 0) process.exit(0);

const latest = pending[pending.length - 1];
const cmd = latest.unblockCmd || '(no unblockCmd in alert — capture pane and decide)';

const msg = [
  `STOP BLOCKED — ${pending.length} unanswered action_required alert(s) from maestro conductor.`,
  '',
  `Latest: ${latest.session || latest.ticket || '?'} kind=${latest.kind} phase=${latest.phase || '?'} @ ${latest.ts}`,
  `RUN NOW: ${cmd}`,
  '',
  'Or AskUserQuestion to surface to the operator if you are not confident in the choice.',
  '',
  'After acting, ack the alert:',
  `  node -e "require('fs').writeFileSync('${STATE_FILE}', '${latest.ts}')"`,
  '',
  'To disable this guard for the session: MAESTRO_STOP_GUARD=0',
].join('\n');

process.stderr.write(msg + '\n');
process.exit(2);
