'use strict';

/**
 * check/lib/outcome-flags.js — unresolved outcome-verifier flags (GH-756;
 * plan §5.5). Flags are the quality backstop for everything the verifier
 * advanced UNVERIFIED: the check step REFUSES to complete while any task
 * still carries unresolved flags. Resolution = the boundary re-verifies
 * clean (the gate rewrites the task's entry), or an operator waiver
 * (`waived: { by, reason }` on the entry — audited by whoever sets it).
 */

const fs = require('fs');
const path = require('path');

/**
 * Read unresolved flag entries from the ticket's work state.
 * @param {string} ticketDir - `$TASKS_BASE/<ticket>`
 * @returns {Array<{ task: number, flags: string[] }>}
 */
function unresolvedOutcomeFlags(ticketDir) {
  let state;
  try {
    state = JSON.parse(fs.readFileSync(path.join(ticketDir, '.work-state.json'), 'utf8'));
  } catch {
    return [];
  }
  const entries = Array.isArray(state && state.outcomeFlags) ? state.outcomeFlags : [];
  return entries.filter((e) => e && Array.isArray(e.flags) && e.flags.length > 0 && !e.waived);
}

/** Human summary line for the needs_work reason. */
function describeUnresolvedFlags(entries) {
  return entries.map((e) => `task ${e.task}: ${e.flags.join(', ')}`).join('; ');
}

/**
 * Completion gate used by check-next.js: when unresolved flags exist, mark
 * the check needs_work (via the caller's saveState) and return the
 * instruction; null when the completion may proceed.
 */
function outcomeFlagGate(tasksBase, safeName, state, saveState) {
  const unresolved = unresolvedOutcomeFlags(path.join(tasksBase, safeName));
  if (unresolved.length === 0) return null;
  state.status = 'needs_work';
  saveState(safeName, state);
  return {
    type: 'check_instruction',
    action: 'needs_work',
    state: { ticket: safeName, currentStep: state.currentStep },
    reason:
      `Check cannot complete: unresolved outcome-verifier flags — ` +
      `${describeUnresolvedFlags(unresolved)}. Fix and re-verify the flagged ` +
      `task(s), or record an operator waiver on the flag entry.`,
  };
}

module.exports = { unresolvedOutcomeFlags, describeUnresolvedFlags, outcomeFlagGate };
