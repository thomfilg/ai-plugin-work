const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  classifyCommentPriority,
  isBotAuthorLogin,
  isBlockingPriority,
  getResolvedCommentIds,
  resolveOutdatedThreads,
  decideNextAction,
  getAdaptiveInterval,
  getCodeContext,
  partitionByRequired,
  formatReport,
} = require('../follow-up-pr.js');

describe('classifyCommentPriority', () => {
  describe('Copilot (copilot-pull-request-reviewer)', () => {
    const author = 'copilot-pull-request-reviewer';

    it('returns low for [nitpick] comments', () => {
      assert.equal(
        classifyCommentPriority(author, '[nitpick] Consider renaming this variable'),
        'low'
      );
    });

    it('returns low for [NITPICK] (case-insensitive)', () => {
      assert.equal(classifyCommentPriority(author, '[NITPICK] Minor style issue'), 'low');
    });

    it('returns medium for comments without [nitpick]', () => {
      assert.equal(classifyCommentPriority(author, 'This function has a bug'), 'medium');
    });

    it('returns medium for empty body', () => {
      assert.equal(classifyCommentPriority(author, ''), 'medium');
    });

    it('returns medium for null body', () => {
      assert.equal(classifyCommentPriority(author, null), 'medium');
    });

    it('returns high for [critical] tag', () => {
      assert.equal(
        classifyCommentPriority(author, '[critical] Security vulnerability in auth'),
        'high'
      );
    });

    it('returns high for [high] tag', () => {
      assert.equal(classifyCommentPriority(author, '[high] Missing error handling'), 'high');
    });

    it('returns medium for [medium] tag', () => {
      assert.equal(classifyCommentPriority(author, '[medium] Consider refactoring'), 'medium');
    });

    it('returns low for [low] tag', () => {
      assert.equal(classifyCommentPriority(author, '[low] Minor naming suggestion'), 'low');
    });
  });

  describe('Copilot (inline comments via "Copilot" login)', () => {
    const author = 'Copilot';

    it('returns low for [nitpick] tag', () => {
      assert.equal(classifyCommentPriority(author, '[nitpick] Style preference'), 'low');
    });

    it('returns high for [critical] tag', () => {
      assert.equal(classifyCommentPriority(author, '[critical] Data loss risk'), 'high');
    });

    it('returns medium when no severity tag', () => {
      assert.equal(classifyCommentPriority(author, 'This needs fixing'), 'medium');
    });

    it('does not false-match [low] tag appearing inside body text (not at start)', () => {
      const body =
        '[critical] Step 5.4 says to "skip the comment entirely"...\n```suggestion\n1. If the conflicting AI comment is non-blocking ([low] or [nitpick]):\n```';
      assert.equal(classifyCommentPriority(author, body), 'high');
    });
  });

  describe('Cursor (cursor-ai[bot])', () => {
    const author = 'cursor-ai[bot]';

    it('returns high for **severity**: critical', () => {
      assert.equal(
        classifyCommentPriority(author, '**severity**: critical\nThis is a security issue'),
        'high'
      );
    });

    it('returns high for **severity**: high', () => {
      assert.equal(
        classifyCommentPriority(author, '**severity**: high\nMissing error handling'),
        'high'
      );
    });

    it('returns high for severity: major', () => {
      assert.equal(classifyCommentPriority(author, 'severity: major — race condition'), 'high');
    });

    it('returns medium for **severity**: medium', () => {
      assert.equal(
        classifyCommentPriority(author, '**severity**: medium\nConsider refactoring'),
        'medium'
      );
    });

    it('returns medium for severity: moderate', () => {
      assert.equal(
        classifyCommentPriority(author, 'severity: moderate — could be cleaner'),
        'medium'
      );
    });

    it('returns low for **severity**: minor', () => {
      assert.equal(
        classifyCommentPriority(author, '**severity**: minor\nNaming suggestion'),
        'low'
      );
    });

    it('returns low for severity: low', () => {
      assert.equal(classifyCommentPriority(author, 'severity: low — just a thought'), 'low');
    });

    it('returns low for severity: nitpick', () => {
      assert.equal(classifyCommentPriority(author, 'severity: nitpick'), 'low');
    });

    it('returns low for severity: trivial', () => {
      assert.equal(classifyCommentPriority(author, 'severity: trivial — whitespace'), 'low');
    });

    it('returns low for severity: suggestion', () => {
      assert.equal(classifyCommentPriority(author, 'severity: suggestion'), 'low');
    });

    it('returns medium when no severity marker found', () => {
      assert.equal(classifyCommentPriority(author, 'This code could be improved'), 'medium');
    });

    it('returns medium for empty body', () => {
      assert.equal(classifyCommentPriority(author, ''), 'medium');
    });
  });

  describe('Codex (chatgpt-codex-connector[bot])', () => {
    const author = 'chatgpt-codex-connector[bot]';

    it('returns high for P1 badge', () => {
      assert.equal(classifyCommentPriority(author, '![P1 Badge] Critical issue found'), 'high');
    });

    it('returns medium for P2 badge', () => {
      assert.equal(classifyCommentPriority(author, '![P2 Badge] Consider fixing'), 'medium');
    });

    it('returns low for P3 badge', () => {
      assert.equal(classifyCommentPriority(author, '![P3 Badge] Minor suggestion'), 'low');
    });

    it('returns medium for comments without P-badge', () => {
      assert.equal(classifyCommentPriority(author, 'no badge comment'), 'low');
    });
  });

  describe('Codex (chatgpt-codex-connector alias)', () => {
    const author = 'chatgpt-codex-connector';

    it('returns high for P1 badge (alias)', () => {
      assert.equal(classifyCommentPriority(author, '![P1 Badge] Critical issue found'), 'high');
    });
  });

  describe('Human reviewers', () => {
    it('returns high for any human reviewer', () => {
      assert.equal(classifyCommentPriority('octocat', 'Please fix this'), 'high');
    });

    it('returns high for unknown authors', () => {
      assert.equal(classifyCommentPriority('some-user', ''), 'high');
    });

    it('returns high regardless of body content', () => {
      assert.equal(
        classifyCommentPriority('reviewer123', '[nitpick] even with nitpick tag'),
        'high'
      );
    });
  });
});

describe('isBotAuthorLogin', () => {
  const defaultBots = [
    'copilot-pull-request-reviewer',
    'cursor-ai[bot]',
    'chatgpt-codex-connector[bot]',
  ];

  it('returns true for chatgpt-codex-connector[bot]', () => {
    assert.equal(isBotAuthorLogin('chatgpt-codex-connector[bot]', defaultBots), true);
  });

  it('returns true for chatgpt-codex-connector (fuzzy match strips [bot])', () => {
    assert.equal(isBotAuthorLogin('chatgpt-codex-connector', defaultBots), true);
  });
});

describe('isBlockingPriority', () => {
  it('returns true for high', () => {
    assert.equal(isBlockingPriority('high'), true);
  });

  it('returns true for medium', () => {
    assert.equal(isBlockingPriority('medium'), true);
  });

  it('returns false for low', () => {
    assert.equal(isBlockingPriority('low'), false);
  });
});

describe('getResolvedCommentIds', () => {
  function makeComments(ids) {
    return {
      totalCount: ids.length,
      nodes: ids.map((id) => ({ databaseId: id })),
    };
  }

  function makeGraphQLResponse(threads, hasNextPage = false, endCursor = null) {
    return {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage, endCursor },
              nodes: threads,
            },
          },
        },
      },
    };
  }

  it('returns empty set when no threads exist', () => {
    const exec = () => makeGraphQLResponse([]);
    const { resolved } = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(resolved.size, 0);
  });

  it('collects comment IDs from resolved threads', () => {
    const exec = () =>
      makeGraphQLResponse([
        { isResolved: true, isOutdated: false, comments: makeComments([100, 101]) },
        { isResolved: false, isOutdated: false, comments: makeComments([200]) },
      ]);
    const { resolved } = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(resolved.has(100), true);
    assert.equal(resolved.has(101), true);
    assert.equal(resolved.has(200), false);
  });

  it('collects comment IDs from outdated threads', () => {
    const exec = () =>
      makeGraphQLResponse([
        { id: 'PRRT_1', isResolved: false, isOutdated: true, comments: makeComments([300]) },
      ]);
    const { resolved } = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(resolved.has(300), true);
  });

  it('collects all comments per thread (not just first)', () => {
    const exec = () =>
      makeGraphQLResponse([
        { isResolved: true, isOutdated: false, comments: makeComments([1, 2, 3]) },
      ]);
    const { resolved } = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(resolved.size, 3);
    assert.equal(resolved.has(1), true);
    assert.equal(resolved.has(2), true);
    assert.equal(resolved.has(3), true);
  });

  it('paginates through multiple pages of threads', () => {
    let callCount = 0;
    const exec = () => {
      callCount++;
      if (callCount === 1) {
        return makeGraphQLResponse(
          [{ isResolved: true, isOutdated: false, comments: makeComments([10]) }],
          true,
          'cursor-abc'
        );
      }
      return makeGraphQLResponse([
        { isResolved: true, isOutdated: false, comments: makeComments([20]) },
      ]);
    };
    const { resolved } = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(resolved.size, 2);
    assert.equal(resolved.has(10), true);
    assert.equal(resolved.has(20), true);
    assert.equal(callCount, 2);
  });

  it('returns empty set on GraphQL failure (graceful fallback)', () => {
    const exec = () => {
      throw new Error('GraphQL failed');
    };
    const { resolved, outdatedThreadIds } = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(resolved.size, 0);
    assert.equal(outdatedThreadIds.length, 0);
  });

  it('returns empty set when GraphQL returns errors without data', () => {
    const exec = () => ({ errors: [{ message: 'Rate limited' }] });
    const { resolved } = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(resolved.size, 0);
  });

  it('processes partial data when GraphQL returns errors with data', () => {
    const exec = () => ({
      errors: [{ message: 'Partial failure' }],
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ isResolved: true, isOutdated: false, comments: makeComments([42]) }],
            },
          },
        },
      },
    });
    const { resolved } = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(resolved.has(42), true);
  });

  it('handles threads with missing comments gracefully', () => {
    const exec = () =>
      makeGraphQLResponse([
        { isResolved: true, isOutdated: false, comments: makeComments([]) },
        { isResolved: true, isOutdated: false, comments: null },
        { isResolved: true, isOutdated: false },
      ]);
    const { resolved } = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(resolved.size, 0);
  });

  it('does not pass cursor arg on first request', () => {
    let capturedArgs = null;
    const exec = (args) => {
      if (!capturedArgs) capturedArgs = args;
      return makeGraphQLResponse([]);
    };
    getResolvedCommentIds('owner/repo', 1, exec);
    const hasCursorArg = capturedArgs.some((a) => typeof a === 'string' && a.startsWith('cursor='));
    assert.equal(hasCursorArg, false);
  });

  it('clears partial results on mid-pagination failure', () => {
    let callCount = 0;
    const exec = () => {
      callCount++;
      if (callCount === 1) {
        return makeGraphQLResponse(
          [{ isResolved: true, isOutdated: false, comments: makeComments([10]) }],
          true,
          'cursor-abc'
        );
      }
      throw new Error('Network error mid-pagination');
    };
    const { resolved } = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(resolved.size, 0, 'should return empty set on partial failure');
  });

  it('returns outdated thread IDs for threads that are outdated but not resolved', () => {
    const exec = () =>
      makeGraphQLResponse([
        {
          id: 'PRRT_outdated1',
          isResolved: false,
          isOutdated: true,
          comments: makeComments([500]),
        },
        { id: 'PRRT_resolved', isResolved: true, isOutdated: true, comments: makeComments([501]) },
        { id: 'PRRT_active', isResolved: false, isOutdated: false, comments: makeComments([502]) },
      ]);
    const { outdatedThreadIds } = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(outdatedThreadIds.length, 1);
    assert.equal(outdatedThreadIds[0], 'PRRT_outdated1');
  });
});

describe('resolveOutdatedThreads', () => {
  it('calls resolveReviewThread mutation for each thread ID', () => {
    const calls = [];
    const exec = (args) => {
      calls.push(args);
      return { data: { resolveReviewThread: { thread: { isResolved: true } } } };
    };
    const dismissed = resolveOutdatedThreads(['PRRT_1', 'PRRT_2'], exec);
    assert.equal(dismissed, 2);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes('threadId=PRRT_1'));
    assert.ok(calls[1].includes('threadId=PRRT_2'));
  });

  it('returns 0 for empty array', () => {
    const exec = () => {
      throw new Error('should not be called');
    };
    const dismissed = resolveOutdatedThreads([], exec);
    assert.equal(dismissed, 0);
  });

  it('continues on individual thread failure and returns partial count', () => {
    let callCount = 0;
    const exec = () => {
      callCount++;
      if (callCount === 2) throw new Error('Permission denied');
      return { data: { resolveReviewThread: { thread: { isResolved: true } } } };
    };
    const dismissed = resolveOutdatedThreads(['PRRT_1', 'PRRT_2', 'PRRT_3'], exec);
    assert.equal(dismissed, 2);
    assert.equal(callCount, 3);
  });
});

describe('decideNextAction', () => {
  const mergeReady = { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' };
  const conflicting = { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
  const notReady = { mergeable: 'UNKNOWN', mergeStateStatus: 'BEHIND' };
  const noReviews = { hasBlocking: false, pendingBots: [], nonBlocking: [] };
  const blockingReviews = { hasBlocking: true, pendingBots: [], blocking: [{ author: 'user' }] };
  const blockedByApproval = { mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' };
  const pendingBots = { hasBlocking: false, pendingBots: ['copilot-pull-request-reviewer'] };

  it('returns exit-fail with ci-failing when CI fails', () => {
    const result = decideNextAction('failing', mergeReady, noReviews, false);
    assert.equal(result.action, 'exit-fail');
    assert.equal(result.finalStatus, 'ci-failing');
  });

  it('CI failure takes precedence over conflicts', () => {
    const result = decideNextAction('failing', conflicting, blockingReviews, false);
    assert.equal(result.action, 'exit-fail');
    assert.equal(result.finalStatus, 'ci-failing');
  });

  it('returns exit-fail with conflicting when merge conflicts exist (even with pending CI)', () => {
    const result = decideNextAction('pending', conflicting, noReviews, false);
    assert.equal(result.action, 'exit-fail');
    assert.equal(result.finalStatus, 'conflicting');
  });

  it('returns poll (not exit-fail) when blocking reviews exist but CI is still pending', () => {
    const result = decideNextAction('pending', mergeReady, blockingReviews, false);
    assert.equal(result.action, 'poll');
    assert.match(result.waitReason, /waiting for CI to finish before evaluating reviews/);
  });

  it('exits reviews-blocking after CI passes with blocking reviews', () => {
    const result = decideNextAction('passing', mergeReady, blockingReviews, false);
    assert.equal(result.action, 'exit-fail');
    assert.equal(result.finalStatus, 'reviews-blocking');
  });

  it('exits with ci-cancelled when CI is cancelled', () => {
    const result = decideNextAction('cancelled', mergeReady, noReviews, false);
    assert.equal(result.action, 'exit-fail');
    assert.equal(result.finalStatus, 'ci-cancelled');
  });

  it('returns exit-success when CI has no checks, reviews clear, merge ready', () => {
    const result = decideNextAction('no-checks', mergeReady, noReviews, false);
    assert.equal(result.action, 'exit-success');
    assert.equal(result.finalStatus, 'ready');
  });

  it('returns exit-fail with reviews-blocking when no-checks CI and blocking reviews', () => {
    const result = decideNextAction('no-checks', mergeReady, blockingReviews, false);
    assert.equal(result.action, 'exit-fail');
    assert.equal(result.finalStatus, 'reviews-blocking');
  });

  it('skips review check when noReviews is true', () => {
    const result = decideNextAction('passing', mergeReady, blockingReviews, true);
    assert.equal(result.action, 'exit-success');
    assert.equal(result.finalStatus, 'ready');
  });

  it('returns exit-success when CI passes, reviews clear, merge ready', () => {
    const result = decideNextAction('passing', mergeReady, noReviews, false);
    assert.equal(result.action, 'exit-success');
    assert.equal(result.finalStatus, 'ready');
  });

  it('returns poll with CI reason when CI is pending', () => {
    const result = decideNextAction('pending', mergeReady, noReviews, false);
    assert.equal(result.action, 'poll');
    assert.match(result.waitReason, /CI checks pending/);
  });

  it('returns poll with bot reason when bots are pending', () => {
    const result = decideNextAction('passing', mergeReady, pendingBots, false);
    assert.equal(result.action, 'poll');
    assert.match(result.waitReason, /bot reviews pending/);
  });

  it('returns poll (not exit-fail) when blocking reviews exist but bot reviews are pending', () => {
    const blockingWithPendingBots = {
      hasBlocking: true,
      pendingBots: ['copilot-pull-request-reviewer'],
      blocking: [{ author: 'copilot' }],
    };
    const result = decideNextAction('passing', mergeReady, blockingWithPendingBots, false);
    assert.equal(result.action, 'poll');
    assert.match(result.waitReason, /blocking reviews may become stale/);
  });

  it('returns poll with merge status reason when not merge-ready', () => {
    const result = decideNextAction('passing', notReady, noReviews, false);
    assert.equal(result.action, 'poll');
    assert.match(result.waitReason, /merge status: BEHIND/);
  });

  // ── BLOCKED merge status tests ──────────────────────────────────────────────
  it('returns exit-success with blocked-by-approval when BLOCKED, CI passing, reviews clear', () => {
    const result = decideNextAction('passing', blockedByApproval, noReviews, false);
    assert.equal(result.action, 'exit-success');
    assert.equal(result.finalStatus, 'blocked-by-approval');
  });

  it('returns exit-fail with ci-failing when BLOCKED and CI fails', () => {
    const result = decideNextAction('failing', blockedByApproval, noReviews, false);
    assert.equal(result.action, 'exit-fail');
    assert.equal(result.finalStatus, 'ci-failing');
  });

  it('returns exit-fail with conflicting when BLOCKED but has conflicts', () => {
    const blockedConflicting = { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' };
    const result = decideNextAction('passing', blockedConflicting, noReviews, false);
    assert.equal(result.action, 'exit-fail');
    assert.equal(result.finalStatus, 'conflicting');
  });

  it('returns poll when BLOCKED and CI is pending', () => {
    const result = decideNextAction('pending', blockedByApproval, noReviews, false);
    assert.equal(result.action, 'poll');
  });

  it('returns exit-success with blocked-by-approval when BLOCKED, no-checks CI, reviews clear', () => {
    const result = decideNextAction('no-checks', blockedByApproval, noReviews, false);
    assert.equal(result.action, 'exit-success');
    assert.equal(result.finalStatus, 'blocked-by-approval');
  });

  it('returns exit-fail with reviews-blocking when BLOCKED and reviews are blocking', () => {
    const result = decideNextAction('passing', blockedByApproval, blockingReviews, false);
    assert.equal(result.action, 'exit-fail');
    assert.equal(result.finalStatus, 'reviews-blocking');
  });

  it('returns exit-success when BLOCKED, CI passing, noReviews is true', () => {
    const result = decideNextAction('passing', blockedByApproval, blockingReviews, true);
    assert.equal(result.action, 'exit-success');
    assert.equal(result.finalStatus, 'blocked-by-approval');
  });

  it('returns exit-fail with ci-cancelled when BLOCKED and CI is cancelled', () => {
    const result = decideNextAction('cancelled', blockedByApproval, noReviews, false);
    assert.equal(result.action, 'exit-fail');
    assert.equal(result.finalStatus, 'ci-cancelled');
  });

  it('includes human-readable message when exiting success due to blocked-by-approval', () => {
    const result = decideNextAction('passing', blockedByApproval, noReviews, false);
    assert.ok(result.message, 'should include a message');
    assert.match(result.message, /blocked.*approval/i);
  });

  // checkCI returns 'passing' when only optional (non-required) checks fail.
  // These tests verify that decideNextAction correctly exits success in that
  // scenario, confirming the full checkCI → decideNextAction pipeline handles
  // optional-only failures as non-blocking.
  it('returns exit-success when ciStatus is passing (optional-only failures) and merge ready', () => {
    const result = decideNextAction('passing', mergeReady, noReviews, false);
    assert.equal(result.action, 'exit-success');
    assert.equal(result.finalStatus, 'ready');
  });

  it('returns exit-success when ciStatus is passing (optional-only failures) and blocked-by-approval', () => {
    const result = decideNextAction('passing', blockedByApproval, noReviews, false);
    assert.equal(result.action, 'exit-success');
    assert.equal(result.finalStatus, 'blocked-by-approval');
  });

  // ── BLOCKED + unresolved conversations (non-blocking comments) ──────────
  it('returns exit-fail with unresolved-conversations when BLOCKED, CI passing, non-blocking comments exist', () => {
    const nonBlockingComments = {
      hasBlocking: false,
      pendingBots: [],
      nonBlocking: [{ author: 'copilot', body: '[low] suggestion' }],
    };
    const result = decideNextAction('passing', blockedByApproval, nonBlockingComments, false);
    assert.equal(result.action, 'exit-fail');
    assert.equal(result.finalStatus, 'unresolved-conversations');
  });

  it('returns exit-success when BLOCKED, CI passing, truly no comments at all', () => {
    const result = decideNextAction('passing', blockedByApproval, noReviews, false);
    assert.equal(result.action, 'exit-success');
    assert.equal(result.finalStatus, 'blocked-by-approval');
  });

  it('includes unresolved thread count in message when BLOCKED by conversations', () => {
    const twoComments = {
      hasBlocking: false,
      pendingBots: [],
      nonBlocking: [{ author: 'a' }, { author: 'b' }],
    };
    const result = decideNextAction('passing', blockedByApproval, twoComments, false);
    assert.ok(result.message);
    assert.match(result.message, /2.*unresolved/i);
  });
});

describe('getAdaptiveInterval', () => {
  const makeCi = (passed, running, failed = [], cancelled = []) => ({
    total: passed.length + running.length + failed.length + cancelled.length,
    passed: passed.map((n) => ({ name: n })),
    running: running.map((n) => ({ name: n })),
    failed: failed.map((n) => ({ name: n })),
    cancelled: cancelled.map((n) => ({ name: n })),
  });

  it('returns 10s on first attempt (quick sanity check)', () => {
    const ci = makeCi(['lint'], ['test', 'build', 'e2e', 'security', 'coverage']);
    assert.equal(getAdaptiveInterval(1, ci), 10);
  });

  it('returns 60s for >5 steps with low completion', () => {
    const ci = makeCi(['lint'], ['test', 'build', 'e2e', 'security', 'coverage']);
    assert.equal(getAdaptiveInterval(2, ci), 60);
  });

  it('returns 30s for <=5 steps with low completion', () => {
    const ci = makeCi(['lint'], ['test', 'build']);
    assert.equal(getAdaptiveInterval(2, ci), 30);
  });

  it('returns 20s when >=80% of steps are complete (>5 steps)', () => {
    const ci = makeCi(['lint', 'test', 'build', 'e2e', 'security'], ['coverage']);
    assert.equal(getAdaptiveInterval(3, ci), 20);
  });

  it('returns 20s when >=80% of steps are complete (<=5 steps)', () => {
    const ci = makeCi(['lint', 'test', 'build', 'e2e'], ['security']);
    assert.equal(getAdaptiveInterval(3, ci), 20);
  });

  it('counts failed and cancelled steps as completed for ratio', () => {
    const ci = makeCi(['lint', 'test'], ['e2e'], ['build'], ['security']);
    // 4/5 = 80% completed
    assert.equal(getAdaptiveInterval(2, ci), 20);
  });

  it('returns 30s when no checks exist (total=0, attempt>1)', () => {
    const ci = makeCi([], []);
    assert.equal(getAdaptiveInterval(2, ci), 30);
  });
});

// ── partitionByRequired ──────────────────────────────────────────────────────
describe('partitionByRequired', () => {
  const makeCheck = (name) => ({ name, bucket: 'fail', category: 'unknown' });

  it('treats all failed as required when requiredChecks is null', () => {
    const failed = [makeCheck('lint'), makeCheck('test')];
    const result = partitionByRequired(failed, null);
    assert.equal(result.hasRequiredInfo, false);
    assert.deepStrictEqual(result.requiredFailed, failed);
    assert.deepStrictEqual(result.optionalFailed, []);
  });

  it('treats all failed as required when requiredChecks is empty array', () => {
    const failed = [makeCheck('lint')];
    const result = partitionByRequired(failed, []);
    assert.equal(result.hasRequiredInfo, false);
    assert.deepStrictEqual(result.requiredFailed, failed);
    assert.deepStrictEqual(result.optionalFailed, []);
  });

  it('returns only optional failures when all required checks pass', () => {
    const failed = [makeCheck('optional-lint'), makeCheck('optional-docs')];
    const requiredChecks = ['build', 'test'];
    const result = partitionByRequired(failed, requiredChecks);
    assert.equal(result.hasRequiredInfo, true);
    assert.deepStrictEqual(result.requiredFailed, []);
    assert.deepStrictEqual(result.optionalFailed, failed);
  });

  it('returns required failure when a required check fails', () => {
    const failedBuild = makeCheck('build');
    const failed = [failedBuild];
    const requiredChecks = ['build', 'test'];
    const result = partitionByRequired(failed, requiredChecks);
    assert.equal(result.hasRequiredInfo, true);
    assert.deepStrictEqual(result.requiredFailed, [failedBuild]);
    assert.deepStrictEqual(result.optionalFailed, []);
  });

  it('partitions mixed required and optional failures correctly', () => {
    const failedBuild = makeCheck('build');
    const failedLint = makeCheck('lint');
    const failedDocs = makeCheck('docs');
    const failed = [failedBuild, failedLint, failedDocs];
    const requiredChecks = ['build', 'docs'];
    const result = partitionByRequired(failed, requiredChecks);
    assert.equal(result.hasRequiredInfo, true);
    assert.deepStrictEqual(result.requiredFailed, [failedBuild, failedDocs]);
    assert.deepStrictEqual(result.optionalFailed, [failedLint]);
  });
});

// ── getCodeContext ─────────────────────────────────────────────────────────────
describe('getCodeContext', () => {
  it('returns context lines around the target line', () => {
    // Use this test file itself as a known file
    const result = getCodeContext('workflows/work/scripts/__tests__/follow-up-pr.test.js', 1, 1);
    assert.ok(result, 'should return context');
    assert.ok(result.includes('>>>'), 'should have a marker on the target line');
    assert.ok(result.includes('1:'), 'should have line number 1');
  });

  it('marks the correct line with >>>', () => {
    const result = getCodeContext('workflows/work/scripts/__tests__/follow-up-pr.test.js', 3, 1);
    assert.ok(result);
    const lines = result.split('\n');
    const markedLine = lines.find((l) => l.startsWith('>>>'));
    assert.ok(markedLine, 'should have a >>> marker');
    assert.ok(markedLine.includes('3:'), 'marker should be on line 3');
  });

  it('returns null for non-existent file', () => {
    const result = getCodeContext('non-existent-file-that-does-not-exist.js', 1);
    assert.equal(result, null);
  });

  it('returns null for absolute paths', () => {
    const result = getCodeContext('/etc/passwd', 1);
    assert.equal(result, null);
  });

  it('returns null for path traversal attempts', () => {
    const result = getCodeContext('../../../etc/passwd', 1);
    assert.equal(result, null);
  });

  it('handles out-of-range line numbers gracefully', () => {
    const result = getCodeContext(
      'workflows/work/scripts/__tests__/follow-up-pr.test.js',
      999999,
      1
    );
    // Should return some content (the last lines of the file) or empty, not crash
    assert.ok(result !== undefined);
  });

  it('handles line 1 without negative index', () => {
    const result = getCodeContext('workflows/work/scripts/__tests__/follow-up-pr.test.js', 1, 3);
    assert.ok(result, 'should return context');
    assert.ok(result.includes('>>>'), 'should have marker');
    // Should not have negative line numbers
    assert.ok(!result.includes('-1:'), 'no negative line numbers');
  });
});

// ── formatReport ──────────────────────────────────────────────────────────────
describe('formatReport', () => {
  // Minimal fixtures for formatReport parameters
  const basePrInfo = {
    number: 42,
    title: 'Test PR',
    branch: 'feature-branch',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
  };
  const baseReviews = { hasBlocking: false, pendingBots: [], nonBlocking: [], blocking: [] };
  const baseOpts = { noReviews: false, interval: 30 };

  function makeCi(overrides) {
    return {
      status: 'passing',
      total: 2,
      passed: [{ name: 'build' }, { name: 'test' }],
      running: [],
      failed: [],
      neutral: [],
      cancelled: [],
      optionalFailed: [],
      requiredFailed: [],
      hasRequiredInfo: false,
      ...overrides,
    };
  }

  it('displays optional CI failures as warnings (not errors) when optionalFailed has items', () => {
    const ci = makeCi({
      status: 'passing',
      failed: [{ name: 'lint', category: 'lint' }],
      optionalFailed: [{ name: 'lint', category: 'lint' }],
      requiredFailed: [],
      hasRequiredInfo: true,
    });
    const output = formatReport(basePrInfo, ci, baseReviews, 1, 10, baseOpts);
    assert.match(
      output,
      /Optional CI failures \(non-blocking\)/,
      'should show optional failures warning section'
    );
    assert.match(output, /lint/, 'should list the optional failure name');
  });

  it('includes blocked-by-approval message when decision has that status', () => {
    const ci = makeCi({ status: 'passing' });
    const blockedPrInfo = {
      ...basePrInfo,
      mergeStateStatus: 'BLOCKED',
    };
    const decision = { action: 'exit-success', finalStatus: 'blocked-by-approval' };
    const output = formatReport(blockedPrInfo, ci, baseReviews, 1, 10, baseOpts, decision);
    assert.match(
      output,
      /merge blocked by required approvals only/i,
      'should show blocked-by-approval message'
    );
  });

  it('shows "awaiting required approvals" (not "not yet mergeable") when blocked by approval', () => {
    const ci = makeCi({ status: 'passing' });
    const blockedPrInfo = {
      ...basePrInfo,
      mergeStateStatus: 'BLOCKED',
    };
    const output = formatReport(blockedPrInfo, ci, baseReviews, 1, 10, baseOpts);
    assert.match(
      output,
      /BLOCKED \(awaiting required approvals\)/,
      'should show blocked awaiting approvals message'
    );
    assert.ok(
      !output.includes('not yet mergeable'),
      'should not show generic "not yet mergeable" for blocked-by-approval'
    );
  });

  it('does not show optional failures section when optionalFailed is empty', () => {
    const ci = makeCi({ status: 'passing', optionalFailed: [] });
    const output = formatReport(basePrInfo, ci, baseReviews, 1, 10, baseOpts);
    assert.ok(
      !output.includes('Optional CI failures'),
      'should not show optional failures section'
    );
  });

  it('does not show optional failures section when optionalFailed is undefined', () => {
    const ci = makeCi({ status: 'passing' });
    delete ci.optionalFailed;
    const output = formatReport(basePrInfo, ci, baseReviews, 1, 10, baseOpts);
    assert.ok(
      !output.includes('Optional CI failures'),
      'should not show optional failures section'
    );
  });

  it('backward compat: still shows failed checks normally when no optionalFailed info', () => {
    const ci = makeCi({
      status: 'failing',
      failed: [{ name: 'build', category: 'build' }],
      hasRequiredInfo: false,
    });
    delete ci.optionalFailed;
    delete ci.requiredFailed;
    const output = formatReport(basePrInfo, ci, baseReviews, 1, 10, baseOpts);
    // Should still show the failure with the standard format
    assert.match(output, /build/, 'should display failed check name');
    assert.match(output, /FAILING/, 'should show FAILING status');
  });
});

// ── formatReport review output with BLOCKED merge + non-blocking comments (GH-324 Task 6) ──
describe('formatReport — review output clarity (GH-324)', () => {
  const basePrInfo = {
    number: 42,
    title: 'Test PR',
    branch: 'feature-branch',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
  };
  const baseOpts = { noReviews: false, interval: 30 };

  function makeCi(overrides) {
    return {
      status: 'passing',
      total: 2,
      passed: [{ name: 'build' }, { name: 'test' }],
      running: [],
      failed: [],
      neutral: [],
      cancelled: [],
      optionalFailed: [],
      requiredFailed: [],
      hasRequiredInfo: false,
      ...overrides,
    };
  }

  it('shows UNRESOLVED (not CLEAR) when non-blocking comments exist', () => {
    const ci = makeCi({ status: 'passing' });
    const reviews = {
      hasBlocking: false,
      pendingBots: [],
      blocking: [],
      nonBlocking: [
        { author: 'Copilot', priority: 'low', path: 'file.js', line: 10, body: 'nitpick' },
      ],
    };
    const output = formatReport(basePrInfo, ci, reviews, 1, 10, baseOpts);
    assert.match(output, /UNRESOLVED/, 'should show UNRESOLVED instead of CLEAR');
    assert.ok(!output.match(/Reviews: CLEAR/), 'should NOT say CLEAR when comments exist');
  });

  it('says "address these to unblock merge" instead of "assess whether to address"', () => {
    const ci = makeCi({ status: 'passing' });
    const reviews = {
      hasBlocking: false,
      pendingBots: [],
      blocking: [],
      nonBlocking: [
        { author: 'Copilot', priority: 'low', path: 'file.js', line: 10, body: 'nitpick' },
      ],
    };
    const output = formatReport(basePrInfo, ci, reviews, 1, 10, baseOpts);
    assert.match(
      output,
      /address these to unblock merge/,
      'should say address these to unblock merge'
    );
    assert.ok(
      !output.includes('assess whether to address'),
      'should NOT say assess whether to address'
    );
  });

  it('shows "Merge BLOCKED by N unresolved review comments" when BLOCKED + unresolved comments', () => {
    const ci = makeCi({ status: 'passing' });
    const blockedPrInfo = {
      ...basePrInfo,
      mergeStateStatus: 'BLOCKED',
    };
    const reviews = {
      hasBlocking: false,
      pendingBots: [],
      blocking: [],
      nonBlocking: [
        { author: 'Copilot', priority: 'low', path: 'file.js', line: 10, body: 'nitpick' },
        { author: 'Copilot', priority: 'low', path: 'other.js', line: 5, body: 'style' },
      ],
    };
    const output = formatReport(blockedPrInfo, ci, reviews, 1, 10, baseOpts);
    assert.match(
      output,
      /Merge BLOCKED by 2 unresolved review comment/,
      'should link BLOCKED merge status to unresolved comments count'
    );
  });

  it('still says "awaiting required approvals" when BLOCKED but no unresolved comments', () => {
    const ci = makeCi({ status: 'passing' });
    const blockedPrInfo = {
      ...basePrInfo,
      mergeStateStatus: 'BLOCKED',
    };
    const reviews = {
      hasBlocking: false,
      pendingBots: [],
      blocking: [],
      nonBlocking: [],
    };
    const output = formatReport(blockedPrInfo, ci, reviews, 1, 10, baseOpts);
    assert.match(output, /awaiting required approvals/, 'should show awaiting required approvals');
    assert.ok(
      !output.includes('unresolved comment'),
      'should NOT mention unresolved comments when there are none'
    );
  });

  it('uses "unresolved" wording in blocking reviews non-blocking sub-section too', () => {
    const ci = makeCi({ status: 'passing' });
    const reviews = {
      hasBlocking: true,
      pendingBots: [],
      blocking: [
        { author: 'Copilot', priority: 'medium', path: 'main.js', line: 20, body: 'bug here' },
      ],
      nonBlocking: [
        { author: 'Copilot', priority: 'low', path: 'file.js', line: 10, body: 'nitpick' },
      ],
    };
    const output = formatReport(basePrInfo, ci, reviews, 1, 10, baseOpts);
    assert.match(
      output,
      /unresolved/,
      'should use "unresolved" wording for non-blocking sub-section'
    );
    assert.ok(
      !output.includes('assess whether to address'),
      'should NOT use "assess whether to address" in blocking section either'
    );
  });
});

describe('ghExec shared module', () => {
  it('is importable from shared gh-exec module', () => {
    const { ghExec } = require('../gh-exec.js');
    assert.equal(typeof ghExec, 'function');
  });
});
