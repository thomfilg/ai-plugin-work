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
// 'reviews' and 'ci_cancelled_blocking' are set by triage's routeTo — they
// were missing here, so a workflow that finished handling its review comments
// (or a cancelled-CI retry) re-surfaced forever instead of completing
// (echo-6204, memory: followup-reviews-surface-loop).
const KNOWN_RESOLVABLE_CATEGORIES = new Set([
  'infra-stuck',
  'conflict',
  'ci_failure',
  'review_failure',
  'reviews',
  'ci_cancelled_blocking',
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

// Bug 542-11/542-13: repo owner/name derivation lives in `../repo-meta.js`
// (shared with follow-up-next.js); per-worktree cached.
const { detectRepoSlug } = require('../repo-meta');

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

// Write the accountability report once (never overwrites an existing one).
// Uses the write-exclusive 'wx' flag so the create-once check is atomic — no
// check-then-write race — and fails open if the file already exists or the
// write errors.
function writeAccountabilityReport(reportPath, state, solvedReviews, skippedReviews) {
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
      ),
      { flag: 'wx' }
    );
  } catch {
    /* fail-open — report already exists or write failed */
  }
}

// One line per terminal review comment so the operator sees exactly WHAT was
// addressed and how — previously comments were marked solved/skipped/outdated
// with, at most, an aggregate count ("agents mark messages as addressed but
// do not notify me").
function itemizeReviewComments(tasksDir) {
  try {
    const snapshot = JSON.parse(
      fs.readFileSync(path.join(tasksDir, 'follow-up-comments.json'), 'utf8')
    );
    const label = { solved: '✔ solved', skipped: '⤼ skipped', resolved: '⌛ outdated' };
    return (snapshot.comments || [])
      .filter((c) => label[c.status])
      .map((c) => {
        const fileRef = c.path ? `${c.path}${c.line ? `:${c.line}` : ''}` : 'general';
        const why = c.resolution ? ` — ${String(c.resolution).slice(0, 140)}` : '';
        return `  ${label[c.status]} [${c.author || 'unknown'}] ${fileRef}${why}`;
      });
  } catch {
    return [];
  }
}

function buildCompleteResult(state, solvedReviews, skippedReviews, ctx) {
  const lines = itemizeReviewComments(ctx && ctx.tasksDir);
  const headline = `Follow-up complete for ${state.ticketId} PR #${state.prNumber || '?'} after ${state.attempt || 1} attempt(s)`;
  const countsLine =
    lines.length > 0 || solvedReviews || skippedReviews
      ? `Review comments: ${solvedReviews} solved, ${skippedReviews} skipped (details in follow-up-comments.json / review-accountability.json)`
      : '';
  return {
    type: 'follow_up_instruction',
    action: 'complete',
    state: { ticket: state.ticketId, currentStep: 'report', attempt: state.attempt },
    summary: [headline, countsLine, ...lines].filter(Boolean).join('\n'),
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

    const skippedReviews = state._skippedReviewsCount || 0;
    const solvedReviews = state._solvedReviewsCount || 0;
    const reportPath = path.join(ctx.tasksDir, 'review-accountability.json');
    writeAccountabilityReport(reportPath, state, solvedReviews, skippedReviews);

    state.status = 'complete';
    return buildCompleteResult(state, solvedReviews, skippedReviews, ctx);
  });
};
