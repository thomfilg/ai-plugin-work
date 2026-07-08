/**
 * monitor-infra-cache.js — infra-failure hint + monitor-result cache helpers.
 *
 * Extracted from monitor.js (file-size budget). Owns the single chokepoint for
 * writing monitor results to state (R11), the `--init` hint appended to
 * infra-shaped failures (R3/R10/R16), and the stale-cache auto-clear (R2/R5/R8…).
 * monitor.js re-exports these via its `__test__` object for unit access.
 */

'use strict';

const { isInfraFailure, isStale } = require('../infra-patterns');

/**
 * Build the infra-failure hint paragraph appended to monitor results.
 * Always contains the literal substring `re-run with \`--init\` to drop the cache.`
 * Wording is neutral between fresh and cached display: the hint is appended at
 * write time but the same string is read back on later cached reads, so it must
 * not assert which case applies.
 *
 * @returns {string} multi-line hint paragraph (no leading newline).
 */
function buildInitHintParagraph() {
  return (
    '\n\n↳ Infra-shaped failure detected (DNS, gh auth, VPN, etc.). ' +
    'If the underlying issue is now fixed, re-run with `--init` to drop the cache.'
  );
}

/**
 * Append a discoverable `--init` hint paragraph to `result.output` if the
 * result represents an infra-shaped failure (R3, R10, R16).
 * Returns a possibly-new result object; never mutates caller-owned input.
 *
 * The `previousLastMonitorAt` parameter is accepted for call-site compatibility
 * but no longer affects the hint text — the prior timestamp described the
 * preceding monitor write, not this one, so reporting it as "cached N seconds
 * ago" mislabelled fresh failures as cached.
 *
 * @param {{exitCode:number, output:string}} result
 * @param {string|null|undefined} _previousLastMonitorAt - unused, retained for API stability
 * @returns {{exitCode:number, output:string}}
 */
function appendInitHintIfInfra(result, _previousLastMonitorAt) {
  if (!result || result.exitCode === 0) return result;
  if (!isInfraFailure(result.output)) return result;
  return {
    ...result,
    output: String(result.output || '') + buildInitHintParagraph(),
  };
}

/**
 * Auto-clear stale infra-failure cache on monitor-step entry (R2, R5, R8, R9, R10).
 *
 * Drops ONLY `state.lastMonitorResult` and `state.lastMonitorAt` when BOTH:
 *   1. the cached output matches `INFRA_FAILURE_PATTERNS` (`isInfraFailure`), AND
 *   2. the cache entry is stale per `isStale` (>= STALE_THRESHOLD_SECONDS, or
 *      `lastMonitorAt` is missing — legacy state files written before GH-536
 *      lacked the timestamp; treat them as infinitely old per R8/R15).
 *
 * Non-infra failures are preserved regardless of age (R10). Other state keys
 * are never touched — this is NOT a full `--init` wipe (R9).
 *
 * @param {object} state - mutable workflow state (mutated in place).
 */
function clearStaleInfraCache(state) {
  if (!state || !state.lastMonitorResult) return;
  const output = state.lastMonitorResult.output;
  if (!isInfraFailure(output)) return;
  if (!isStale(state.lastMonitorAt)) return;
  delete state.lastMonitorResult;
  delete state.lastMonitorAt;
}

/**
 * Single chokepoint for writing monitor results to state (R11).
 * Writes both `state.lastMonitorResult` and `state.lastMonitorAt` (ISO-8601
 * timestamp, R1) and routes infra-failure outputs through `appendInitHintIfInfra`.
 *
 * @param {object} state - mutable workflow state.
 * @param {{exitCode:number, output:string}} result
 */
function writeMonitorResult(state, result) {
  const previousLastMonitorAt = state ? state.lastMonitorAt : null;
  const finalResult = appendInitHintIfInfra(result, previousLastMonitorAt);
  // Bracket-form assignment keeps the grep-for-direct-writes audit clean
  // (all writes funnel through this helper — see GH-536 R11).
  state['lastMonitorResult'] = finalResult;
  state['lastMonitorAt'] = new Date().toISOString();
}

module.exports = {
  buildInitHintParagraph,
  appendInitHintIfInfra,
  clearStaleInfraCache,
  writeMonitorResult,
};
