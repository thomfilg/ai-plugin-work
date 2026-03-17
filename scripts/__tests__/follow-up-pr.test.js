const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { classifyCommentPriority, isBlockingPriority, getResolvedCommentIds } = require('../follow-up-pr.js');

describe('classifyCommentPriority', () => {
  describe('Copilot (copilot-pull-request-reviewer)', () => {
    const author = 'copilot-pull-request-reviewer';

    it('returns low for [nitpick] comments', () => {
      assert.equal(classifyCommentPriority(author, '[nitpick] Consider renaming this variable'), 'low');
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
      assert.equal(classifyCommentPriority(author, '[critical] Security vulnerability in auth'), 'high');
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
  });

  describe('Cursor (cursor-ai[bot])', () => {
    const author = 'cursor-ai[bot]';

    it('returns high for **severity**: critical', () => {
      assert.equal(classifyCommentPriority(author, '**severity**: critical\nThis is a security issue'), 'high');
    });

    it('returns high for **severity**: high', () => {
      assert.equal(classifyCommentPriority(author, '**severity**: high\nMissing error handling'), 'high');
    });

    it('returns high for severity: major', () => {
      assert.equal(classifyCommentPriority(author, 'severity: major — race condition'), 'high');
    });

    it('returns medium for **severity**: medium', () => {
      assert.equal(classifyCommentPriority(author, '**severity**: medium\nConsider refactoring'), 'medium');
    });

    it('returns medium for severity: moderate', () => {
      assert.equal(classifyCommentPriority(author, 'severity: moderate — could be cleaner'), 'medium');
    });

    it('returns low for **severity**: minor', () => {
      assert.equal(classifyCommentPriority(author, '**severity**: minor\nNaming suggestion'), 'low');
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

  describe('Human reviewers', () => {
    it('returns high for any human reviewer', () => {
      assert.equal(classifyCommentPriority('octocat', 'Please fix this'), 'high');
    });

    it('returns high for unknown authors', () => {
      assert.equal(classifyCommentPriority('some-user', ''), 'high');
    });

    it('returns high regardless of body content', () => {
      assert.equal(classifyCommentPriority('reviewer123', '[nitpick] even with nitpick tag'), 'high');
    });
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
  function makeComments(ids, hasNextPage = false, endCursor = null) {
    return {
      pageInfo: { hasNextPage, endCursor },
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
    const ids = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(ids.size, 0);
  });

  it('collects comment IDs from resolved threads', () => {
    const exec = () => makeGraphQLResponse([
      { isResolved: true, isOutdated: false, comments: makeComments([100, 101]) },
      { isResolved: false, isOutdated: false, comments: makeComments([200]) },
    ]);
    const ids = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(ids.has(100), true);
    assert.equal(ids.has(101), true);
    assert.equal(ids.has(200), false);
  });

  it('collects comment IDs from outdated threads', () => {
    const exec = () => makeGraphQLResponse([
      { isResolved: false, isOutdated: true, comments: makeComments([300]) },
    ]);
    const ids = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(ids.has(300), true);
  });

  it('collects all comments per thread (not just first)', () => {
    const exec = () => makeGraphQLResponse([
      { isResolved: true, isOutdated: false, comments: makeComments([1, 2, 3]) },
    ]);
    const ids = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(ids.size, 3);
    assert.equal(ids.has(1), true);
    assert.equal(ids.has(2), true);
    assert.equal(ids.has(3), true);
  });

  it('paginates through multiple pages of threads', () => {
    let callCount = 0;
    const exec = () => {
      callCount++;
      if (callCount === 1) {
        return makeGraphQLResponse(
          [{ isResolved: true, isOutdated: false, comments: makeComments([10]) }],
          true, 'cursor-abc',
        );
      }
      return makeGraphQLResponse(
        [{ isResolved: true, isOutdated: false, comments: makeComments([20]) }],
      );
    };
    const ids = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(ids.size, 2);
    assert.equal(ids.has(10), true);
    assert.equal(ids.has(20), true);
    assert.equal(callCount, 2);
  });

  it('returns empty set on GraphQL failure (graceful fallback)', () => {
    const exec = () => { throw new Error('GraphQL failed'); };
    const ids = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(ids.size, 0);
  });

  it('returns empty set when GraphQL returns errors without data', () => {
    const exec = () => ({ errors: [{ message: 'Rate limited' }] });
    const ids = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(ids.size, 0);
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
    const ids = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(ids.has(42), true);
  });

  it('handles threads with missing comments gracefully', () => {
    const exec = () => makeGraphQLResponse([
      { isResolved: true, isOutdated: false, comments: makeComments([]) },
      { isResolved: true, isOutdated: false, comments: null },
      { isResolved: true, isOutdated: false },
    ]);
    const ids = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(ids.size, 0);
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
          true, 'cursor-abc',
        );
      }
      throw new Error('Network error mid-pagination');
    };
    const ids = getResolvedCommentIds('owner/repo', 1, exec);
    assert.equal(ids.size, 0, 'should return empty set on partial failure');
  });
});
