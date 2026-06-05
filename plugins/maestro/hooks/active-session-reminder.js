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
  lines.push(
    '  CLI: node plugins/maestro/scripts/maestro-session.js {summary|show <topic>|next <topic>|update <topic> <task> <status>|clear <topic>}'
  );

  process.stdout.write(lines.join('\n') + '\n');
} catch {
  /* fail-open */
}
