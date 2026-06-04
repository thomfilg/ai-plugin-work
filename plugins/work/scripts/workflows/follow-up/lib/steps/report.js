/**
 * Step: report — Generate review-accountability.json on success. Marks complete.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Format a single infra-retry attempt into a human-readable diagnostic line.
 * Includes the GitHub Actions run URL so the surfaced bundle is clickable.
 * @param {{attemptNumber:number, timestamp:string, runId:string|number, signals:string[], retryMethod:string}} attempt
 * @param {string} repoUrl - https://github.com/<owner>/<repo>
 */
function formatAttemptLine(attempt, repoUrl) {
  const signals = Array.isArray(attempt.signals) ? attempt.signals.join(',') : '';
  const runUrl = `${repoUrl}/actions/runs/${attempt.runId}`;
  return [
    `- attemptNumber=${attempt.attemptNumber}`,
    `timestamp=${attempt.timestamp}`,
    `runId=${attempt.runId}`,
    `signals=[${signals}]`,
    `retryMethod=${attempt.retryMethod}`,
    `url=${runUrl}`,
  ].join(' ');
}

// Categories whose failureCategory has dedicated handling elsewhere in the
// workflow (or is being routed to another step); not surfaced from `report`.
const KNOWN_RESOLVABLE_CATEGORIES = new Set([
  'infra-stuck',
  'conflict',
  'ci_failure',
  'review_failure',
]);

/**
 * Surface a generic failureCategory (e.g. 'github-actions-outage') so report
 * does not silently mark complete. Bug 3 (GH-508).
 */
function buildGenericSurface(state) {
  return {
    type: 'follow_up_instruction',
    action: 'surface',
    payload: { reason: state.failureCategory },
    state: {
      ticket: state.ticketId,
      currentStep: 'report',
      attempt: state.attempt,
    },
    summary: `Follow-up surfaced for ${state.ticketId}: ${state.failureCategory}. Manual intervention required.`,
  };
}

// Bug 542-11: derive repo owner/name from git remote when state didn't carry
// them — production state never sets repoOwner/repoName, so URLs used to fall
// back to `OWNER`/`REPO` placeholders. Tries `gh repo view` first, then parses
// `git remote get-url origin`. Cached per-process.
const cp = require('node:child_process');
// Bug 542-13: cache MUST be keyed per-worktree — a single process can serve
// multiple tickets across multiple worktrees, each pointing at a different
// origin remote. The prior single-var cache leaked the first worktree's
// owner/name into every subsequent ticket's diagnostic URLs.
const _repoSlugCache = new Map();
function detectRepoSlug(worktreeDir) {
  const key = worktreeDir || process.cwd();
  if (_repoSlugCache.has(key)) return _repoSlugCache.get(key);
  const runQuiet = (cmd) => {
    try {
      return cp
        .execSync(cmd, {
          cwd: worktreeDir,
          encoding: 'utf8',
          timeout: 8000,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        .trim();
    } catch {
      return '';
    }
  };
  const json = runQuiet('gh repo view --json owner,name');
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (parsed && parsed.owner && parsed.name) {
        const slug = { owner: parsed.owner.login || parsed.owner, name: parsed.name };
        _repoSlugCache.set(key, slug);
        return slug;
      }
    } catch {
      /* fall through to git remote parse */
    }
  }
  const url = runQuiet('git remote get-url origin');
  const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?$/);
  if (m) {
    const slug = { owner: m[1], name: m[2] };
    _repoSlugCache.set(key, slug);
    return slug;
  }
  const empty = { owner: null, name: null };
  _repoSlugCache.set(key, empty);
  return empty;
}

/** R11: infra-stuck diagnostic bundle. */
function buildInfraStuckSurface(state, ctx) {
  const attempts = (state.infraRetry && state.infraRetry.attempts) || [];
  const slug = detectRepoSlug(ctx && ctx.worktreeDir);
  const owner = state.repoOwner || (slug && slug.owner) || 'OWNER';
  const repo = state.repoName || (slug && slug.name) || 'REPO';
  const repoUrl = `https://github.com/${owner}/${repo}`;
  const header = `## Infra-stuck after ${attempts.length} retries`;
  const lines = attempts.map((a) => formatAttemptLine(a, repoUrl));
  const body = [header, ...lines].join('\n');
  return {
    type: 'follow_up_instruction',
    action: 'surface',
    payload: { reason: 'infra-stuck', attempts, repoUrl },
    state: {
      ticket: state.ticketId,
      currentStep: 'report',
      attempt: state.attempt,
    },
    summary: body,
  };
}

module.exports = function registerReport(register) {
  register('report', (state, ctx) => {
    // Final safety net: never mark complete while the latest monitor cycle
    // still shows merge conflicts.
    const lastOutput = (state.lastMonitorResult && state.lastMonitorResult.output) || '';
    if (state._isConflicting || /merge conflict|cannot be merged/i.test(lastOutput)) {
      state.failureCategory = 'conflict';
      state.currentStep = 'fix-ci';
      return null;
    }

    // Bug 3 (GH-508): unresolved surface categories must NOT mark complete.
    if (state.failureCategory && !KNOWN_RESOLVABLE_CATEGORIES.has(state.failureCategory)) {
      return buildGenericSurface(state);
    }

    if (state.failureCategory === 'infra-stuck') {
      return buildInfraStuckSurface(state, ctx);
    }

    // Write accountability report if it doesn't exist
    const reportPath = path.join(ctx.tasksDir, 'review-accountability.json');
    const skippedReviews = state._skippedReviewsCount || 0;
    const solvedReviews = state._solvedReviewsCount || 0;
    if (!fs.existsSync(reportPath)) {
      try {
        fs.writeFileSync(
          reportPath,
          JSON.stringify(
            {
              ticketId: state.ticketId,
              prNumber: state.prNumber,
              attempts: state.attempt || 1,
              completedAt: new Date().toISOString(),
              status: 'success',
              reviewComments: { solved: solvedReviews, skipped: skippedReviews },
            },
            null,
            2
          )
        );
      } catch {
        /* fail-open */
      }
    }

    state.status = 'complete';

    const skipSuffix = skippedReviews
      ? ` — ${solvedReviews} review${solvedReviews !== 1 ? 's' : ''} fixed, ${skippedReviews} skipped (see follow-up-comments.json for rationale).`
      : '';

    return {
      type: 'follow_up_instruction',
      action: 'complete',
      state: { ticket: state.ticketId, currentStep: 'report', attempt: state.attempt },
      summary: `Follow-up complete for ${state.ticketId} PR #${state.prNumber || '?'} after ${state.attempt || 1} attempt(s)${skipSuffix}`,
    };
  });
};
