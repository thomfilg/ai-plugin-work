'use strict';

/**
 * halted-waiting.js — recognize the "agent is correctly halted, waiting on a
 * human" pane patterns so phase-stall is suppressed instead of nudging.
 *
 * Extracted verbatim from maestro-conduct.js (no behavior change): when any of
 * these patterns match the captured pane, the agent is intentionally idle
 * (awaiting merge, refusing to auto-merge, CI green) and must NOT be treated as
 * stuck.
 */

// Healthy "waiting on user" patterns the agent emits to the pane while halted.
// When detected, phase-stall is suppressed — the agent is not stuck.
const HALTED_WAITING_PATTERNS = [
  /awaiting.*merge|wait.*merge|Once you( click| have)? merge/i,
  /Per.*never-auto-merge|won['’]t merge|won['’]t auto-merge/i,
  /CI is green.*[Mm]erge when ready/i,
];

function isHaltedWaitingForUser(pane) {
  if (!pane) return false;
  return HALTED_WAITING_PATTERNS.some((re) => re.test(pane));
}

module.exports = { HALTED_WAITING_PATTERNS, isHaltedWaitingForUser };
