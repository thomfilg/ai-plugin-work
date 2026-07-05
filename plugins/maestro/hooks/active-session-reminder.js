#!/usr/bin/env node
/**
 * active-session-reminder.js — UserPromptSubmit / SessionStart hook.
 *
 * If a maestro orchestration session is active (a manifest exists under
 * MAESTRO_SESSION_DIR), inject a reminder block so the operator (or a fresh
 * conversation) doesn't:
 *   - accidentally start a second parallel orchestration
 *   - forget the priority + dependency plan
 *   - lose track of which tasks are in flight vs done vs pending
 *
 * Install (user must add to ~/.claude/settings.json — plugin can't auto-install):
 *
 *   "UserPromptSubmit": [{
 *     "matcher": ".*",
 *     "hooks": [{
 *       "type": "command",
 *       "command": "node /path/to/plugins/maestro/hooks/active-session-reminder.js"
 *     }]
 *   }]
 *
 * Fail-open: any error → exit 0 silently. Never block the prompt.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const {
  SESSION_DIR,
  countByStatus,
  doneIdSet,
  eligibleTasks,
} = require('../scripts/lib/maestro-conduct/session-shared');
const namespace = require('../scripts/lib/maestro-conduct/namespace');

// Pending-decision surfacing: actionable alerts younger than this window are
// re-shown on every user prompt. This is the "ask me when I'm looking at the
// screen" channel — the hook fires exactly when the user types, so decisions
// queue here instead of blocking the conductor loop on AskUserQuestion (which
// froze all agent-event processing until the human answered). Live problems
// keep re-emitting on their cooldowns, so they stay inside the window;
// resolved ones age out.
const PENDING_WINDOW_MIN = parseInt(process.env.MAESTRO_PENDING_WINDOW_MIN || '90', 10);
const PENDING_KINDS = new Set([
  'question-pending',
  'nudges-exhausted',
  'wedged',
  'dead-end',
  'pr-broken',
  'pr-ready',
  'stuck-input',
  'spinner-hang',
  'no-progress',
]);

function readAlertTail() {
  try {
    const fd = fs.openSync(namespace.alertFile(), 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 64 * 1024);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

function parsePendingAlert(line, cutoff) {
  if (!line.trim()) return null;
  let a;
  try {
    a = JSON.parse(line);
  } catch {
    return null;
  }
  if (!a || !PENDING_KINDS.has(a.kind)) return null;
  const ts = Date.parse(a.ts || '');
  if (!ts || ts < cutoff) return null;
  return a;
}

function pendingDecisionLines() {
  const raw = readAlertTail();
  if (!raw) return [];
  const cutoff = Date.now() - PENDING_WINDOW_MIN * 60 * 1000;
  const latest = new Map(); // session|kind → newest alert wins
  for (const line of raw.split('\n')) {
    const a = parsePendingAlert(line, cutoff);
    if (a) latest.set(`${a.session || a.ticket}|${a.kind}`, a);
  }
  if (!latest.size) return [];
  const out = ['  PENDING DECISIONS (recent actionable alerts — handle or they re-fire):'];
  for (const a of latest.values()) {
    const inst = String(a.instruction || '').slice(0, 160);
    out.push(`    ⚑ ${a.session || a.ticket} ${a.kind}: ${inst}`);
  }
  return out;
}

try {
  if (!fs.existsSync(SESSION_DIR)) process.exit(0);
  const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith('.json'));
  if (!files.length) process.exit(0);

  const lines = [
    '[maestro] ACTIVE ORCHESTRATION SESSION(S) — do not start a parallel orchestration without checking these first:',
  ];
  for (const f of files) {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    const counts = countByStatus(s.tasks);
    lines.push(
      `  • ${s.topic} — slots=${s.slots} | ` +
        `${counts.in_progress} in flight, ${counts.done}/${s.tasks.length} done, ${counts.pending} pending` +
        (counts.blocked ? `, ${counts.blocked} blocked` : '')
    );
    // Show the next 3 eligible tasks (deps resolved, sorted by priority).
    const doneIds = doneIdSet(s.tasks);
    const eligible = eligibleTasks(s.tasks).slice(0, 3);
    if (eligible.length) {
      lines.push(
        `    next eligible: ${eligible
          .map(
            (t) =>
              `${t.id}#p${t.priority}${(t.deps || []).length ? `[deps:${t.deps.join(',')}✓]` : ''}`
          )
          .join(', ')}`
      );
    }
    const blockedByDeps = s.tasks
      .filter((t) => t.status === 'pending')
      .filter((t) => (t.deps || []).some((d) => !doneIds.has(d)));
    if (blockedByDeps.length) {
      lines.push(
        `    waiting on deps: ${blockedByDeps
          .slice(0, 3)
          .map((t) => `${t.id}(needs: ${(t.deps || []).filter((d) => !doneIds.has(d)).join(',')})`)
          .join(', ')}`
      );
    }
  }
  lines.push(...pendingDecisionLines());
  lines.push(
    '  CLI: node plugins/maestro/scripts/maestro-session.js {summary|show <topic>|next <topic>|update <topic> <task> <status>|sync|clear <topic>}'
  );

  process.stdout.write(lines.join('\n') + '\n');
} catch {
  /* fail-open */
}
