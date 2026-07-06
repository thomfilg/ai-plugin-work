/**
 * monitor-notices.js — review-notice helpers for the monitor step.
 *
 * Extracted from monitor.js (file-size budget), behavior unchanged:
 * - demoteNonAllowlistedCommentedReviews: GH-670 demotion of body-only
 *   COMMENTED reviews from non-allowlisted reviewers to non-blocking notices.
 * - notifyOnNewBlockingComments: operator mailbox ping when the blocking
 *   review-comment count grows mid-poll.
 */

'use strict';

const { notifyOperator } = require('../notify');

// GH-670 aggravator: body-only COMMENTED reviews (review-level, no file path)
// from reviewers OUTSIDE the FOLLOW_UP_PR_BOT_REVIEWERS allowlist — e.g.
// greptile-apps[bot] posting "trial credit limit reached" as COMMENTED
// reviews — were classified as BLOCKING review work. A COMMENTED review can
// never block the merge and cannot be dismissed via the API, so the workflow
// span forever on unactionable noise. Demote them to non-blocking notices
// (counted separately) and recompute hasBlocking / the exit signal.
//
// Invariants preserved:
//   - CHANGES_REQUESTED stays blocking regardless of reviewer (never demoted).
//   - Inline comments (item.path set) keep their classification.
//   - Allowlisted bot reviewers are untouched (their COMMENTED reviews are
//     already filtered upstream by getReviews' isActionableReview; the
//     isBotAuthorLogin guard here keeps that behavior even if one leaks
//     through).
// Fail-open: when follow-up-pr.js does not export isBotAuthorLogin (older
// copy), no demotion happens and behavior is unchanged.
function demoteNonAllowlistedCommentedReviews(reviews, isBotAuthorLogin) {
  reviews.notices = reviews.notices || [];
  if (typeof isBotAuthorLogin !== 'function') return reviews;
  if (!Array.isArray(reviews.blocking) || reviews.blocking.length === 0) return reviews;
  const isNotice = (item) =>
    item.state === 'COMMENTED' && !item.path && !isBotAuthorLogin(item.author);
  const notices = reviews.blocking.filter(isNotice);
  if (notices.length === 0) return reviews;
  reviews.blocking = reviews.blocking.filter((item) => !isNotice(item));
  reviews.notices.push(...notices);
  reviews.hasBlocking = reviews.blocking.length > 0;
  return reviews;
}

// Ping the operator mailbox when the blocking-comment count GROWS — new bot
// review comments used to arrive silently while the agent idled in the poll
// loop ("agents get stuck with no notifications of messages").
//
// The first observation only SEEDS the counter: comments already present at
// workflow start are being actively processed by fix-reviews anyway, and
// notifying for them meant every `--init` re-announced already-known comments
// (review finding on PR #666).
function notifyOnNewBlockingComments(state, reviews) {
  const count = reviews && reviews.blocking ? reviews.blocking.length : 0;
  if (state._lastBlockingCount === undefined) {
    state._lastBlockingCount = count;
    return;
  }
  const previous = state._lastBlockingCount;
  if (count > previous) {
    notifyOperator(
      state.ticketId,
      `${count - previous} new blocking review comment(s) on PR #${state.prNumber || '?'} (${count} total)`
    );
  }
  state._lastBlockingCount = count;
}

module.exports = { demoteNonAllowlistedCommentedReviews, notifyOnNewBlockingComments };
