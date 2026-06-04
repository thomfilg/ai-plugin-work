/**
 * Step: infra-retry — Gate CI retries on infra-flake evidence (R2-R5, R12,
 * R14-R17).
 *
 * Implements the off-flag / bypass short-circuits, Task 7 telemetry append
 * (R14), the retry-success stderr log (R15), and the GitHub Actions outage
 * early-surface (R16).
 *
 * See also: synapsys memory [[never-rerun-ci]] — feature defaults OFF; we
 * only consider a retry when ≥2 signals fire (enforced by the classifier).
 */

'use strict';

const path = require('node:path');

const getConfig = require(path.resolve(__dirname, '..', '..', '..', 'lib', 'get-config'));
const { classify } = require('../infra-classifier');
const { checkActionsStatus } = require('../gh-actions-status');

const RETRY_SUCCESS_LOG = 'auto-retry: infra flake confirmed';

/**
 * Decide whether the infra-retry step should short-circuit without touching
 * the classifier.
 *
 * @param {object} state
 * @returns {boolean}
 */
function shouldBypass(state) {
  const flag = getConfig('WORK_AUTO_RETRY_INFRA');
  if (!flag || flag === 'false' || flag === '0') return true;
  const cat = state && state.failureCategory;
  if (cat === 'conflict') return true;
  if (cat === 'review_failure') return true;
  return false;
}

/**
 * Append a telemetry entry to `state.history[]` describing this classify call.
 *
 * R14: every classification produces { timestamp, signals, decision, outcome }.
 */
function recordClassification(state, result) {
  if (!state) return;
  if (!Array.isArray(state.history)) state.history = [];
  state.history.push({
    timestamp: new Date().toISOString(),
    signals: Array.isArray(result && result.signals) ? result.signals.slice() : [],
    decision: result && result.classification,
    outcome: 'pending',
  });
}

/**
 * Detect a prior pending attempt whose retry now succeeded.
 *
 * Task 7.2 (R15): when ctx signals CI is green and the last persisted attempt
 * is still `pending`, mark it `succeeded` and log the canonical literal.
 */
function maybeHandleRetrySuccess(state, ctx) {
  if (!state || !state.infraRetry) return false;
  const attempts = state.infraRetry.attempts;
  if (!Array.isArray(attempts) || attempts.length === 0) return false;
  const last = attempts[attempts.length - 1];
  if (!last || last.outcome !== 'pending') return false;
  const ciStatus = ctx && ctx.ciStatus;
  if (ciStatus !== 'success') return false;
  last.outcome = 'succeeded';
  process.stderr.write(`${RETRY_SUCCESS_LOG}\n`);
  return true;
}

/**
 * Inspect the classifier evidence for the multi-job Signal 4 condition that
 * justifies a githubstatus.com cross-check (R16).
 */
function shouldCheckGhActions(result) {
  if (!result || !result.evidence || !result.evidence.signal4) return false;
  const s4 = result.evidence.signal4;
  if (!s4.fired) return false;
  return Number(s4.jobCount || 0) >= 2;
}

module.exports = function registerInfraRetry(register) {
  register('infra-retry', (state, ctx) => {
    // R12: default the persisted retry record on first read.
    if (state && !state.infraRetry) {
      state.infraRetry = { count: 0, attempts: [] };
    }

    if (shouldBypass(state)) return null;

    // R15: short-circuit on retry-success before consulting the classifier
    // again — we are simply confirming a green run for an already-recorded
    // attempt.
    if (maybeHandleRetrySuccess(state, ctx)) {
      return null;
    }

    // R1e / R7: consult the classifier.
    const result = classify(state || {}, ctx || {});

    // R14: telemetry append on every classification.
    recordClassification(state, result);

    if (!result || result.classification !== 'infra-suspected') return null;

    // R16: cross-check githubstatus.com when multi-job setup failures suggest
    // a platform-wide Actions outage. Skip retry attempts entirely if so.
    if (shouldCheckGhActions(result)) {
      const status = checkActionsStatus({});
      if (status && status.degraded) {
        if (state && state.infraRetry) {
          state.infraRetry.ghActionsStatus = 'degraded';
        }
        return {
          action: 'surface',
          payload: {
            reason: 'github-actions-outage',
            signals: result.signals,
          },
        };
      }
    }

    // Deliverables 3.2 / 3.3 layer attempt-recording and surface-on-exhaust
    // on top of this scaffold. For Task 7's tests we only need the telemetry,
    // success-log, and outage-surface paths above.
    return null;
  });
};

module.exports.RETRY_SUCCESS_LOG = RETRY_SUCCESS_LOG;
