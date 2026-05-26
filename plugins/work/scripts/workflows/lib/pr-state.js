/**
 * pr-state.js
 *
 * Gate F — pure helper that reads `.work-state.json` (or accepts an
 * already-loaded state object) and decides whether the PR for the active
 * ticket has been closed without merge.
 *
 * Used by the follow-up enrichment: a closed-not-merged PR forces /work
 * back through brief (full re-plan) rather than looping through implement.
 * This prevents the failure mode where an agent absorbed sibling scope,
 * the user closed the PR, and the orchestrator silently retried the same
 * scope in `implement` on the next /work invocation.
 */

'use strict';

/**
 * @param {object|null|undefined} workState - parsed .work-state.json
 * @returns {boolean} true when the workflow records a CLOSED, NOT-MERGED PR
 */
function isPrClosedWithoutMerge(workState) {
  if (!workState || typeof workState !== 'object') return false;
  const pr = workState.pr || workState._prState || null;
  if (!pr || typeof pr !== 'object') return false;
  // gh's PR JSON uses `state` ∈ {OPEN, CLOSED, MERGED}. Some callers store
  // booleans (`merged`, `closed`). Cover both shapes.
  const state = typeof pr.state === 'string' ? pr.state.toUpperCase() : null;
  if (state === 'CLOSED') return true;
  if (state === 'MERGED') return false;
  if (pr.closed === true && pr.merged !== true) return true;
  return false;
}

module.exports = { isPrClosedWithoutMerge };
