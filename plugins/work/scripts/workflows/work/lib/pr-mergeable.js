/**
 * pr-mergeable.js — single source of truth for "can /work advance past CI?".
 *
 * The rule: a PR is mergeable iff GitHub would render the Squash-and-merge
 * button as clickable AND no check is still running. We deliberately mirror
 * GitHub's own UI — when the merge button is enabled, we advance; when it
 * isn't, we block. This is the simplest contract callers can reason about
 * and the one users can verify visually on the PR page.
 *
 * Two independent regressions led here:
 *   - Case A (PR #1960): a Required check was FAILING and "Merging is
 *     blocked" — the workflow advanced anyway because `checkCI()` returned
 *     `status: 'passing'` when `gh pr checks --required` silently returned
 *     an empty array.
 *   - Case B (PR #1929): two local commits unpushed and 9 checks still
 *     running — `follow-up-next.js` returned "Already complete" purely from
 *     its saved state, never asking GitHub.
 *
 * This predicate replaces three pass-through points (ci-gate, follow-up-gate,
 * follow-up-next "Already complete" path) with one cohesive check.
 *
 * Decision matrix:
 *   mergeStateStatus ∈ {CLEAN, UNSTABLE}  AND  no rollup entry still running
 *     → mergeable: true
 *   else
 *     → mergeable: false, blockers list explains why.
 *
 * `UNSTABLE` (non-required check failing, merge button still clickable) is
 * intentionally allowed — we mirror the button, not a stricter rule. If
 * that's the wrong call later, this is the single place to change it.
 */

'use strict';

const { execSync } = require('node:child_process');

const MERGEABLE_STATES = new Set(['CLEAN', 'UNSTABLE']);
const RUNNING_STATUSES = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED']);

function ghJson(args, env) {
  const out = execSync(`gh ${args}`, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(env || {}) },
  });
  return JSON.parse(out);
}

/**
 * Pure classification of `gh pr view --json mergeStateStatus,statusCheckRollup`.
 * Exported separately so tests can drive it without invoking gh.
 *
 * @param {{ mergeStateStatus?: string, statusCheckRollup?: Array<object> }} prData
 * @returns {{ mergeable: boolean, blockers: Array<{kind: string, detail: string}>, signals: object }}
 */
function classify(prData) {
  const mergeStateStatus = (prData && prData.mergeStateStatus) || 'UNKNOWN';
  const rollup = Array.isArray(prData && prData.statusCheckRollup) ? prData.statusCheckRollup : [];

  const running = [];
  for (const entry of rollup) {
    const status = (entry.status || '').toUpperCase();
    const state = (entry.state || '').toUpperCase();
    // GraphQL check-runs use `status`; legacy commit-status entries use `state`.
    // For commit statuses, only PENDING is non-terminal.
    if (status && RUNNING_STATUSES.has(status)) {
      running.push(entry);
      continue;
    }
    if (!status && state === 'PENDING') {
      running.push(entry);
    }
  }

  const blockers = [];
  if (!MERGEABLE_STATES.has(mergeStateStatus)) {
    blockers.push({
      kind: `merge_state_${mergeStateStatus.toLowerCase()}`,
      detail: `GitHub mergeStateStatus is ${mergeStateStatus}; Squash-and-merge button is disabled.`,
    });
  }
  if (running.length > 0) {
    const names = running.map((e) => e.name || e.context || '(unnamed)').slice(0, 10);
    blockers.push({
      kind: 'checks_running',
      detail: `${running.length} check(s) still running: ${names.join(', ')}${running.length > 10 ? '…' : ''}`,
    });
  }

  return {
    mergeable: blockers.length === 0,
    blockers,
    signals: {
      mergeStateStatus,
      rollupTotal: rollup.length,
      runningCount: running.length,
    },
  };
}

/**
 * Live evaluation against GitHub for a given PR number. Returns the same
 * shape as `classify()`. On any gh failure, returns a non-mergeable result
 * with a `gh_error` blocker — never silently allows.
 *
 * @param {number|string} prNumber
 * @param {object} [opts] - { repo?: string } to override the default repo
 * @returns {{ mergeable: boolean, blockers: Array<{kind: string, detail: string}>, signals: object }}
 */
function assessMergeable(prNumber, opts) {
  if (prNumber == null || prNumber === '') {
    return {
      mergeable: false,
      blockers: [{ kind: 'no_pr', detail: 'No PR number provided.' }],
      signals: {},
    };
  }
  const repoFlag = opts && opts.repo ? ` --repo ${opts.repo}` : '';
  try {
    const data = ghJson(
      `pr view ${prNumber}${repoFlag} --json mergeStateStatus,statusCheckRollup,state,headRefOid`
    );
    const result = classify(data);
    result.signals.prState = data.state;
    result.signals.headRefOid = data.headRefOid;
    return result;
  } catch (err) {
    return {
      mergeable: false,
      blockers: [
        {
          kind: 'gh_error',
          detail: `gh pr view failed: ${(err && err.message) || String(err)}. Cannot verify mergeability; refusing to advance.`,
        },
      ],
      signals: {},
    };
  }
}

/**
 * Decide whether a non-mergeable result is actionable — i.e. whether the
 * caller should take destructive recovery action (rollback / rewind) or
 * just wait. Centralises the two guards both follow-up-next.js and
 * ci-gate.js have to apply:
 *
 *   1. Filter out `gh_error` blockers (transient gh CLI failures). Those
 *      mean "we couldn't reach GitHub to verify", not "we verified the PR
 *      is broken" — taking destructive action on a network blip discards
 *      real progress.
 *   2. Require the PR state to be `OPEN`. A `MERGED` PR can transiently
 *      report `mergeStateStatus: UNKNOWN` for ~5-30s after merge, which
 *      produces a non-mergeable result even though the work is done.
 *      Acting on that would churn the workflow.
 *
 * Callers that don't have a separately-fetched PR state can pass
 * `opts.prStateOverride = '<MERGED|OPEN|CLOSED|...>'` — when the
 * assessMergeable result already populated `signals.prState`, omit the
 * override and the helper reads it from the signals.
 *
 * @param {{mergeable: boolean, blockers: Array<{kind: string, detail?: string}>, signals?: {prState?: string}}} mergeResult
 * @param {{prStateOverride?: string}} [opts]
 * @returns {{ actionable: boolean, realBlockers: Array<{kind: string, detail?: string}>, prState: string }}
 */
function hasActionableBlockers(mergeResult, opts) {
  const blockers = (mergeResult && mergeResult.blockers) || [];
  const realBlockers = blockers.filter((b) => b && b.kind !== 'gh_error');
  const prStateRaw =
    (opts && opts.prStateOverride) ||
    (mergeResult && mergeResult.signals && mergeResult.signals.prState) ||
    '';
  // Empty / unknown PR state defaults to "treat as open" so callers that
  // don't fetch PR state (or stub without it) still see the historical
  // behaviour. Only an explicit non-OPEN value (MERGED, CLOSED) suppresses
  // destructive action.
  const prIsOpen = prStateRaw === '' || prStateRaw === 'OPEN';
  const actionable = !!mergeResult && !mergeResult.mergeable && realBlockers.length > 0 && prIsOpen;
  return { actionable, realBlockers, prState: prStateRaw };
}

module.exports = {
  assessMergeable,
  classify,
  hasActionableBlockers,
  MERGEABLE_STATES,
  RUNNING_STATUSES,
};
