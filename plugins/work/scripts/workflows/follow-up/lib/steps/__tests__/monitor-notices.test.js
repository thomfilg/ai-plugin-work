'use strict';

// monitor-notices.test.js — GH-670 aggravator: body-only COMMENTED reviews
// from reviewers OUTSIDE the FOLLOW_UP_PR_BOT_REVIEWERS allowlist (e.g.
// greptile-apps[bot] posting "trial credit limit reached" as COMMENTED
// reviews) were classified as BLOCKING review work. A COMMENTED review can
// never block the merge and cannot be dismissed via the API, so the workflow
// deadlocked on unactionable noise. They must be demoted to non-blocking
// notices, counted separately, while CHANGES_REQUESTED and inline comments
// keep their blocking classification.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { demoteNonAllowlistedCommentedReviews } = require('../monitor.js').__test__;
const { buildOutput, buildStatusLine } = require('../monitor-status-line.js');
// Real allowlist matcher (pure function; follow-up-pr.js is require.main-guarded).
const { isBotAuthorLogin } = require(
  path.join(__dirname, '..', '..', '..', '..', 'work', 'scripts', 'follow-up-pr.js')
);

function reviewsWith(blocking) {
  return {
    all: [],
    comments: [],
    actionable: [...blocking],
    blocking: [...blocking],
    nonBlocking: [],
    pendingBots: [],
    hasBlocking: blocking.length > 0,
    hasActionable: blocking.length > 0,
  };
}

const greptileNotice = {
  id: 'r1',
  author: 'greptile-apps[bot]',
  state: 'COMMENTED',
  body: 'Your team is currently on a trial and has reached its credit limit.',
  path: null,
};

describe('monitor — non-allowlisted COMMENTED reviews become notices (GH-670)', () => {
  it('demotes a body-only COMMENTED review from a non-allowlisted bot', () => {
    const reviews = demoteNonAllowlistedCommentedReviews(
      reviewsWith([greptileNotice]),
      isBotAuthorLogin
    );
    assert.equal(reviews.blocking.length, 0, 'not blocking review work');
    assert.equal(reviews.hasBlocking, false, 'exit signal must not stay red');
    assert.equal(reviews.notices.length, 1, 'counted separately as a notice');
    assert.equal(reviews.notices[0].id, 'r1');
  });

  it('CHANGES_REQUESTED stays blocking regardless of reviewer', () => {
    const cr = { ...greptileNotice, id: 'r2', state: 'CHANGES_REQUESTED' };
    const reviews = demoteNonAllowlistedCommentedReviews(reviewsWith([cr]), isBotAuthorLogin);
    assert.equal(reviews.blocking.length, 1);
    assert.equal(reviews.hasBlocking, true);
    assert.equal(reviews.notices.length, 0);
  });

  it('inline comments (path set) keep their blocking classification', () => {
    const inline = { ...greptileNotice, id: 'r3', path: 'src/a.js', line: 4 };
    const reviews = demoteNonAllowlistedCommentedReviews(reviewsWith([inline]), isBotAuthorLogin);
    assert.equal(reviews.blocking.length, 1);
    assert.equal(reviews.notices.length, 0);
  });

  it('allowlisted bot reviewers are never demoted (behavior preserved)', () => {
    const cursor = { ...greptileNotice, id: 'r4', author: 'cursor-ai[bot]' };
    const reviews = demoteNonAllowlistedCommentedReviews(reviewsWith([cursor]), isBotAuthorLogin);
    assert.equal(reviews.blocking.length, 1, 'allowlisted bot item untouched');
    assert.equal(reviews.notices.length, 0);
  });

  it('fails open when isBotAuthorLogin is unavailable (older follow-up-pr.js)', () => {
    const reviews = demoteNonAllowlistedCommentedReviews(reviewsWith([greptileNotice]), undefined);
    assert.equal(reviews.blocking.length, 1, 'no demotion without the allowlist matcher');
    assert.deepEqual(reviews.notices, []);
  });

  it('output shows the notice count and never re-triggers the BLOCKING signal', () => {
    const reviews = demoteNonAllowlistedCommentedReviews(
      reviewsWith([greptileNotice, { ...greptileNotice, id: 'r5' }]),
      isBotAuthorLogin
    );
    const ci = { status: 'passing', running: [], passed: [], failed: [], cancelled: [] };
    const throwingFormatReport = () => {
      throw new Error('force fallback');
    };
    const output = buildOutput(
      { attempt: 1 },
      { number: 7, title: 't' },
      ci,
      reviews,
      throwingFormatReport
    );
    assert.match(output, /Notices: 2 notice\(s\)/);
    assert.match(output, /Reviews: CLEAR/);
    // triage's routing signal must NOT fire on the notice line.
    assert.equal(/Reviews:.*BLOCKING/i.test(output), false);
    // Status-line counts show notices separately (🔔), not as 💬 blocking.
    const { parts } = buildStatusLine({ attempt: 1 }, ci, reviews);
    assert.match(parts.counts, /🔔 2/);
    assert.doesNotMatch(parts.counts, /💬/);
  });

  it("follow-up-next normalizes the 'reviews' surface reason to 'review_failure'", () => {
    const { canonicalFailureCategory } = require('../../../follow-up-next.js').__test__;
    assert.equal(canonicalFailureCategory('reviews'), 'review_failure');
    assert.equal(canonicalFailureCategory('infra-stuck'), 'infra-stuck');
  });
});
