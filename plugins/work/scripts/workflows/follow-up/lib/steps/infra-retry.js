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
const MAX_INFRA_RETRIES = 3;
const NUMERIC_RUN_ID = /^\d+$/;

/**
 * Categories that bypass the infra-retry step entirely — these failures are
 * not infrastructure-related and have dedicated handling elsewhere.
 *
 * Note: previously gated additionally by WORK_AUTO_RETRY_INFRA env flag. The
 * flag was removed (always-on per user decision GH-508) — the signal floor
 * (≥2 of 4 INFRA_SUSPECTED_PAIRS), MAX_INFRA_RETRIES cap, and the exhaustion
 * surface are the only safeguards needed.
 */
function categoryBypass(state) {
  const cat = state && state.failureCategory;
  return cat === 'conflict' || cat === 'review_failure';
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
function lastPendingAttempt(state) {
  if (!state || !state.infraRetry) return null;
  const attempts = state.infraRetry.attempts;
  if (!Array.isArray(attempts) || attempts.length === 0) return null;
  const last = attempts[attempts.length - 1];
  if (!last || last.outcome !== 'pending') return null;
  return last;
}

function ciStatusIsFreshSuccess(state, ctx) {
  if (!ctx || ctx.ciStatus !== 'success') return false;
  const freshness = state._ciStatusFreshness;
  return Boolean(freshness && freshness.pid === process.pid);
}

function maybeHandleRetrySuccess(state, ctx) {
  const last = lastPendingAttempt(state);
  if (!last) return false;
  if (!ciStatusIsFreshSuccess(state, ctx)) return false;
  last.outcome = 'succeeded';
  process.stderr.write(`${RETRY_SUCCESS_LOG}\n`);
  routeRetrySuccessToReport(state);
  return true;
}

/**
 * Inspect the classifier evidence for the multi-job Signal 4 condition that
 * justifies a githubstatus.com cross-check (R16).
 */
function shouldCheckGhActions(result) {
  if (!result || !Array.isArray(result.signals)) return false;
  if (!result.signals.includes('signal4')) return false;
  const s4Evidence = (result.evidence && result.evidence.signal4) || {};
  return Number(s4Evidence.jobCount || 0) >= 2;
}

/**
 * Build the delegate that retries CI for the current run via
 * `gh run rerun --failed <RUN_ID>`. Validates `runId` against `/^\d+$/`
 * (R17 — no shell injection via state-derived IDs).
 *
 * When `WORK_INFRA_RETRY_FALLBACK=empty-commit` is set, the delegate uses
 * an empty-commit push instead — for environments where `--failed` is
 * unsupported (older gh, forks without write access to the run).
 */
/**
 * Resolve the GitHub Actions run ID to retry. monitor.js stores per-job runIds
 * on state._ciFailedJobs[i].runId — it does NOT populate state.runId. Prefer
 * the failed-job runId; fall back to state.runId for tests/callers that still
 * set it explicitly.
 */
function resolveRunId(state) {
  // Bug 542-20: scan ALL failed jobs for a runId — the first listed failure
  // may lack one while a later entry has it. Falls back to state.runId for
  // tests/callers that set it directly.
  const failedJobs = Array.isArray(state && state._ciFailedJobs) ? state._ciFailedJobs : [];
  for (const job of failedJobs) {
    if (job && job.runId) return job.runId;
  }
  return (state && state.runId) || null;
}

function buildRetryDelegate(state, runId, attemptNumber) {
  if (!NUMERIC_RUN_ID.test(String(runId || ''))) {
    throw new TypeError(
      `infra-retry: runId must match /^\\d+$/, got: ${runId} (refusing to dispatch retry)`
    );
  }
  const fallback = getConfig('WORK_INFRA_RETRY_FALLBACK');
  const useEmptyCommit = fallback === 'empty-commit';
  const command = useEmptyCommit
    ? 'git commit --allow-empty -m "ci: retry infra flake" && git push'
    : `gh run rerun ${runId} --failed`;
  return {
    type: 'follow_up_instruction',
    action: 'execute',
    state: {
      ticket: state && state.ticketId,
      currentStep: 'monitor',
      attempt: attemptNumber,
    },
    continue: true,
    delegate: {
      type: 'bash',
      description: `Retry infra-flake CI (attempt ${attemptNumber}/${MAX_INFRA_RETRIES})`,
      command,
    },
  };
}

/**
 * R16: if multi-job Signal 4 cross-checks show a github.com Actions outage,
 * mark state and return a surface payload. Returns null when no outage applies.
 */
function maybeSurfaceGhActionsOutage(state, result) {
  if (!shouldCheckGhActions(result)) return null;
  const status = checkActionsStatus({});
  if (!status || !status.degraded) return null;
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

/**
 * R2/R3/R4: when retry count has hit the cap, set failureCategory and return
 * the exhaustion surface payload. Returns null otherwise.
 */
function maybeSurfaceExhausted(state, retry, result) {
  if (retry.count < MAX_INFRA_RETRIES) return null;
  state.failureCategory = 'infra-stuck';
  retry.exhausted = true;
  // Bug D+E (GH-508): use the standard surface contract
  // ({ action, payload: { reason, ... } }) AND set reason to 'infra-stuck' so
  // report.js's KNOWN_RESOLVABLE_CATEGORIES match fires the diagnostic bundle.
  // The legacy `reason: 'infra-stuck-exhausted'` was both a shape mismatch
  // (auto-advance hook reads payload.reason) and clobbered the failureCategory
  // away from the value report.js looks for.
  return {
    action: 'surface',
    payload: {
      reason: 'infra-stuck',
      signals: result.signals,
      attempts: retry.attempts,
    },
  };
}

/**
 * Increment retry counter, record the attempt entry, and return the delegate
 * that retries the failed run.
 */
function dispatchRetryAttempt(state, retry, result) {
  const attemptNumber = retry.count + 1;
  const runId = resolveRunId(state);
  // Bug 542-22: if we can't resolve a numeric run id, infra-retry has no
  // GitHub Actions handle to rerun. Return null so the orchestrator advances
  // to fix-ci instead of throwing TypeError (the loop has no catch and would
  // otherwise abort the whole follow-up workflow).
  if (!NUMERIC_RUN_ID.test(String(runId || ''))) return null;
  // Validate before mutating state so a bad runId doesn't consume a retry.
  const delegate = buildRetryDelegate(state, runId, attemptNumber);
  retry.count = attemptNumber;
  retry.attempts.push({
    attemptNumber,
    timestamp: new Date().toISOString(),
    runId: String(runId),
    signals: Array.isArray(result.signals) ? result.signals.slice() : [],
    retryMethod:
      getConfig('WORK_INFRA_RETRY_FALLBACK') === 'empty-commit' ? 'empty-commit' : 'rerun-failed',
    outcome: 'pending',
  });
  state.currentStep = 'monitor';
  return delegate;
}

function isInfraSuspected(result) {
  return Boolean(result) && result.classification === 'infra-suspected';
}

function classifyWithDefaults(state, ctx) {
  return classify(state || {}, ctx || {});
}

function freshnessIsCurrentProcess(state) {
  const f = state && state._ciStatusFreshness;
  return Boolean(f && f.pid === process.pid);
}

// Bug 542-17: the previous version exempted `ctx.ciStatus !== 'success'` as
// "fresh failure", but ciStatus is read from state._ciStatus which can be
// persisted from a prior PID. The only trustworthy fresh-status signal is
// the per-process freshness stamp itself, so drop the redundant exemption.
function needsFreshMonitorBeforeRetry(state, _ctx) {
  const last = lastPendingAttempt(state);
  if (!last) return false;
  if (freshnessIsCurrentProcess(state)) return false;
  return true;
}

// Bug 542-14 + 542-21: if a prior cycle exhausted infra retries, the spec
// forbids dispatching fix-ci even if a later classification would otherwise
// return `code-failure`. Trigger on either the `exhausted` flag OR a count
// already at the cap — the flag is only set on infra-suspected exhaustion,
// but reaching MAX_INFRA_RETRIES via any path counts as exhausted.
function maybeSurfaceAlreadyExhausted(state) {
  if (!state.infraRetry) return null;
  const retry = state.infraRetry;
  const atCap = Number(retry.count || 0) >= MAX_INFRA_RETRIES;
  if (!retry.exhausted && !atCap) return null;
  retry.exhausted = true;
  state.failureCategory = 'infra-stuck';
  return {
    action: 'surface',
    payload: {
      reason: 'infra-stuck',
      attempts: retry.attempts,
      signals: [],
    },
  };
}

function routeRetrySuccessToReport(state) {
  state.currentStep = 'report';
  if (state.failureCategory === 'ci_failure') {
    state.failureCategory = null;
  }
}

function ensureInfraRetryRecord(state) {
  // R12: default the persisted retry record on first read.
  if (state && !state.infraRetry) {
    state.infraRetry = { count: 0, attempts: [] };
  }
}

function runInfraRetryStep(state, ctx) {
  ensureInfraRetryRecord(state);

  // Categories with dedicated handling elsewhere never reach infra-retry.
  if (categoryBypass(state)) return null;

  // Bug 542-18: handle retry-success BEFORE the feature-flag check. If a
  // prior auto-retry left a pending attempt and CI is now green, record the
  // success and route to `report` even after the feature flag was disabled.
  // `maybeHandleRetrySuccess` performs the routing internally on success.
  if (maybeHandleRetrySuccess(state, ctx)) return null;

  // Bug 542-21: exhausted + fresh-monitor gates run BEFORE the feature-flag
  // bypass. A ticket that already hit MAX_INFRA_RETRIES must surface
  // `infra-stuck` regardless of the flag, and a pending retry with stale
  // `_ciStatusFreshness` must re-poll monitor — both must not fall through
  // to fix-ci.

  // Bug 542-16: when resuming from disk after a previous infra rerun, a
  // pending attempt exists but `_ciStatusFreshness` belongs to the prior
  // PID. Bounce back to `monitor` to re-poll CI.
  if (needsFreshMonitorBeforeRetry(state, ctx)) {
    state.currentStep = 'monitor';
    return null;
  }

  const exhaustedSurface = maybeSurfaceAlreadyExhausted(state);
  if (exhaustedSurface) return exhaustedSurface;

  // R1e / R7: consult the classifier.
  const result = classifyWithDefaults(state, ctx);

  // R14: telemetry append on every classification.
  recordClassification(state, result);

  if (!isInfraSuspected(result)) return null;

  const outage = maybeSurfaceGhActionsOutage(state, result);
  if (outage) return outage;

  // R2/R3/R4: retry state machine. Cap at MAX_INFRA_RETRIES (3); on exhaust,
  // surface for human handling. Otherwise dispatch a delegate to re-run.
  const retry = state.infraRetry;
  const exhausted = maybeSurfaceExhausted(state, retry, result);
  if (exhausted) return exhausted;

  return dispatchRetryAttempt(state, retry, result);
}

module.exports = function registerInfraRetry(register) {
  register('infra-retry', runInfraRetryStep);
};

module.exports.RETRY_SUCCESS_LOG = RETRY_SUCCESS_LOG;
