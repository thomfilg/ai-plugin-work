/**
 * check-state-status.js — one definition of "is a /check run still going?",
 * read from `.check-state.json`.
 *
 * ## Why this is shared
 *
 * The session guard suppresses its Stop block while `/check` is running: the
 * check orchestrator drives itself through its own auto-advance hook, so
 * holding the agent there would fight it. That suppression asked
 * `state.status === 'in_progress' || state.currentStep`, and `currentStep` is
 * never cleared when a check finishes — it just stops at `11_output`. So from
 * the first `/check` run onward the bypass was permanently on for that ticket,
 * and the guard stopped protecting every step AFTER check: pr, ready,
 * follow_up, ci, cleanup, reports. The observed symptom was an agent creating
 * the PR and then stopping to ask whether it should go on to follow-up — the
 * Stop hook had quietly excused itself several steps earlier.
 *
 * A finished check is not a running check, and this module is where the guard
 * reads that. `check-next.js handleTerminalState` states the same set inline
 * (it sits exactly at the 400-line quality cap, so it cannot take the require);
 * `__tests__/check-state-status.test.js` carries a grep guard that fails the
 * build if the two ever disagree.
 *
 * ## Statuses
 *
 * `.check-state.json` only ever carries three: `in_progress` (initState),
 * `complete` and `needs_work` (both terminal — see check-next.js
 * `handleTerminalState`, which reopens neither without a fresh cycle).
 * `needs_work` is terminal in the same sense: the run is over and work
 * remains, which is a reason for the guard to hold the agent, not release it.
 */

'use strict';

/** Statuses that mean the /check run is over. Frozen: read-only contract. */
const TERMINAL_CHECK_STATUSES = Object.freeze(['complete', 'needs_work']);

/**
 * True when a check status means the run has finished (either verdict).
 *
 * @param {string|undefined|null} status
 * @returns {boolean}
 */
function isTerminalCheckStatus(status) {
  return TERMINAL_CHECK_STATUSES.includes(String(status || ''));
}

/**
 * True when a parsed `.check-state.json` describes a run still in flight.
 *
 * A terminal status wins over everything else — notably over the leftover
 * `currentStep`, which outlives the run that set it.
 *
 * @param {object|null|undefined} state — parsed `.check-state.json`
 * @returns {boolean}
 */
function isCheckRunInProgress(state) {
  if (!state || typeof state !== 'object') return false;
  if (isTerminalCheckStatus(state.status)) return false;
  return Boolean(state.status === 'in_progress' || state.currentStep);
}

module.exports = {
  TERMINAL_CHECK_STATUSES,
  isCheckRunInProgress,
  isTerminalCheckStatus,
};
