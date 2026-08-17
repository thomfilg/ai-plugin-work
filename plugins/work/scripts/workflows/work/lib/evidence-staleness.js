/**
 * evidence-staleness.js — echo-6842
 *
 * Records that a step's evidence has been invalidated, WITHOUT moving it.
 *
 * Archival used to do both jobs at once: moving `*.check.md` into runs/runN/
 * both preserved the old run and stopped a looped-back workflow from
 * re-satisfying the check gate with reports that reviewed older code. But
 * `archivalPatterns[check]` and `evidenceRequirements[check]` covered the
 * same files, so the move also destroyed the evidence the gate reads. A
 * false rollback left the ticket with "Missing report: tests.check.md" for
 * files sitting one directory away, and `protect-orchestrator-state.js`
 * (correctly) refuses hand restores — so a false archival was terminal.
 *
 * Splitting the two jobs keeps the freshness guarantee and drops the trap:
 *
 *   markEvidenceStale()  stamps the mtimes the evidence had when it was
 *                        invalidated.
 *   isEvidenceStale()    reports it stale until at least one tracked file has
 *                        been rewritten since that stamp — which is exactly
 *                        what re-running the step does.
 *
 * The reports stay where the gate reads them, so an invalidation that turns
 * out to be wrong costs one re-run instead of stranding the ticket, and the
 * gate can say "stale" instead of lying about missing files.
 *
 * Deliberately fail-open in both directions: an unreadable state file, a mark
 * with no tracked files, or an unparseable stamp all read as "not stale".
 * Nothing in here may be the reason a ticket cannot move.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const STATE_FILE = '.work-state.json';

/** mtimeMs per tracked file; absent/unreadable records as null. Never throws. */
function trackedMtimes(tasksDir, files) {
  const tracked = {};
  for (const file of files || []) {
    try {
      tracked[file] = fs.statSync(path.join(tasksDir, file)).mtimeMs;
    } catch {
      tracked[file] = null;
    }
  }
  return tracked;
}

function loadState(tasksDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tasksDir, STATE_FILE), 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Mark `step`'s evidence stale on the in-memory work state. The caller owns
 * persistence (transition-step.js saves ws at the end of the transition).
 *
 * A mark with no tracked files is not recorded: it could never be cleared by
 * re-running the step, which is precisely the dead end this module exists to
 * remove.
 *
 * @param {object} ws        - work state (mutated)
 * @param {string} step      - step id whose evidence is being invalidated
 * @param {string} tasksDir  - TASKS_BASE/<safeTicket>
 * @param {string[]} files   - basenames the step rewrites when it re-runs
 * @param {string} [reason]  - audit-only note ('check-drift', 'step reset', …)
 * @returns {boolean} whether a mark was recorded
 */
function markEvidenceStale(ws, step, tasksDir, files, reason) {
  if (!ws || !step || !files || files.length === 0) return false;
  ws.staleEvidence = ws.staleEvidence || {};
  ws.staleEvidence[step] = {
    reason: reason || null,
    markedAt: new Date().toISOString(),
    files: trackedMtimes(tasksDir, files),
  };
  return true;
}

/** Drop `step`'s stale mark — its gate has since accepted the evidence. */
function clearEvidenceStale(ws, step) {
  if (ws?.staleEvidence) delete ws.staleEvidence[step];
}

/**
 * Stale iff a mark exists and NOT ONE tracked file has changed since it was
 * stamped. Any single rewrite clears the mark for the whole step: `/check`
 * regenerates all its reports together, and requiring every file to change
 * would re-create a dead end whenever one report came back byte-identical.
 * The per-file status rules in check-gate.js still judge the content.
 *
 * @param {string} tasksDir - TASKS_BASE/<safeTicket>
 * @param {string} step     - step id
 * @param {object} [ws]     - work state, when the caller already has it loaded
 * @returns {boolean}
 */
function isEvidenceStale(tasksDir, step, ws) {
  const state = ws === undefined ? loadState(tasksDir) : ws;
  const mark = state?.staleEvidence?.[step];
  const marked = mark?.files;
  if (!marked || Object.keys(marked).length === 0) return false;
  const current = trackedMtimes(tasksDir, Object.keys(marked));
  return Object.keys(marked).every((file) => current[file] === marked[file]);
}

/** Files a stale mark is tracking, for gate messages. Empty when not stale. */
function staleEvidenceFiles(tasksDir, step, ws) {
  if (!isEvidenceStale(tasksDir, step, ws)) return [];
  const state = ws === undefined ? loadState(tasksDir) : ws;
  return Object.keys(state?.staleEvidence?.[step]?.files || {}).sort();
}

module.exports = {
  markEvidenceStale,
  clearEvidenceStale,
  isEvidenceStale,
  staleEvidenceFiles,
};
