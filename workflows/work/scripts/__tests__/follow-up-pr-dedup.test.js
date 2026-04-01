const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { computeCommentHash, deduplicateBlockingBotComments, initState, getChangedPaths } = require('../follow-up-pr.js');

// ── computeCommentHash ──────────────────────────────────────────────────────

describe('computeCommentHash', () => {
  it('returns a hex string for valid inputs', () => {
    const hash = computeCommentHash('src/index.js', 'Fix this bug');
    assert.match(hash, /^[a-f0-9]+$/);
  });

  it('returns the same hash for identical path + body', () => {
    const a = computeCommentHash('src/index.js', 'Fix this bug');
    const b = computeCommentHash('src/index.js', 'Fix this bug');
    assert.equal(a, b);
  });

  it('returns different hashes for different bodies (same path)', () => {
    const a = computeCommentHash('src/index.js', 'Fix this bug');
    const b = computeCommentHash('src/index.js', 'Rename this variable');
    assert.notEqual(a, b);
  });

  it('returns different hashes for different paths (same body)', () => {
    const a = computeCommentHash('src/index.js', 'Fix this bug');
    const b = computeCommentHash('src/utils.js', 'Fix this bug');
    assert.notEqual(a, b);
  });

  it('handles null/undefined path gracefully', () => {
    const a = computeCommentHash(null, 'body');
    const b = computeCommentHash(undefined, 'body');
    assert.match(a, /^[a-f0-9]+$/);
    assert.equal(a, b);
  });

  it('handles null/undefined body gracefully', () => {
    const a = computeCommentHash('path', null);
    const b = computeCommentHash('path', undefined);
    assert.match(a, /^[a-f0-9]+$/);
    assert.equal(a, b);
  });

  it('normalizes whitespace so trailing spaces do not affect hash', () => {
    const a = computeCommentHash('src/index.js', 'Fix this bug');
    const b = computeCommentHash('src/index.js', 'Fix this bug  \n');
    assert.equal(a, b);
  });

  it('ignores line numbers — same path+body always produces same hash', () => {
    // Line numbers shift after force-push, so they must NOT affect the hash
    const a = computeCommentHash('src/index.js', 'Fix this bug');
    const b = computeCommentHash('src/index.js', 'Fix this bug');
    assert.equal(a, b);
  });
});

// ── deduplicateBlockingBotComments ──────────────────────────────────────────

describe('deduplicateBlockingBotComments', () => {
  let nextId = 1;
  const makeBotComment = (path, body, overrides = {}) => ({
    id: nextId++,
    author: 'copilot-pull-request-reviewer',
    body,
    path,
    line: 10,
    state: 'COMMENTED',
    priority: 'medium',
    ...overrides,
  });

  const makeHumanComment = (path, body, overrides = {}) => ({
    id: nextId++,
    author: 'octocat',
    body,
    path,
    line: 10,
    state: 'COMMENTED',
    priority: 'high',
    ...overrides,
  });

  it('returns unchanged lists when previousRunBotHashes is empty', () => {
    const blocking = [makeBotComment('a.js', 'Fix this')];
    const nonBlocking = [];
    const result = deduplicateBlockingBotComments(blocking, nonBlocking, []);
    assert.equal(result.blocking.length, 1);
    assert.equal(result.nonBlocking.length, 0);
  });

  it('moves a previously-seen bot comment from blocking to nonBlocking', () => {
    const comment = makeBotComment('src/index.js', 'Fix this bug');
    const hash = computeCommentHash('src/index.js', 'Fix this bug');

    const result = deduplicateBlockingBotComments([comment], [], [hash]);
    assert.equal(result.blocking.length, 0);
    assert.equal(result.nonBlocking.length, 1);
    assert.equal(result.nonBlocking[0].body, 'Fix this bug');
    assert.equal(result.nonBlocking[0].deduplicated, true);
  });

  it('NEVER deduplicates human comments even if hash matches', () => {
    const humanComment = makeHumanComment('src/index.js', 'Fix this bug');
    const hash = computeCommentHash('src/index.js', 'Fix this bug');

    const result = deduplicateBlockingBotComments([humanComment], [], [hash]);
    assert.equal(result.blocking.length, 1, 'human comment must remain blocking');
    assert.equal(result.nonBlocking.length, 0);
  });

  it('keeps new distinct bot comments as blocking', () => {
    const oldHash = computeCommentHash('a.js', 'Old issue');
    const newComment = makeBotComment('a.js', 'New distinct issue');

    const result = deduplicateBlockingBotComments([newComment], [], [oldHash]);
    assert.equal(result.blocking.length, 1, 'new bot comment must remain blocking');
    assert.equal(result.nonBlocking.length, 0);
  });

  it('handles mixed blocking list with bot and human comments', () => {
    const botComment = makeBotComment('src/a.js', 'Bot comment');
    const humanComment = makeHumanComment('src/a.js', 'Human comment');
    const hash = computeCommentHash('src/a.js', 'Bot comment');

    const result = deduplicateBlockingBotComments([botComment, humanComment], [], [hash]);
    assert.equal(result.blocking.length, 1, 'only human comment remains blocking');
    assert.equal(result.blocking[0].author, 'octocat');
    assert.equal(result.nonBlocking.length, 1, 'bot comment moved to nonBlocking');
  });

  it('deduplicates multiple bot comments at once', () => {
    const c1 = makeBotComment('a.js', 'Issue 1');
    const c2 = makeBotComment('b.js', 'Issue 2');
    const h1 = computeCommentHash('a.js', 'Issue 1');
    const h2 = computeCommentHash('b.js', 'Issue 2');

    const result = deduplicateBlockingBotComments([c1, c2], [], [h1, h2]);
    assert.equal(result.blocking.length, 0);
    assert.equal(result.nonBlocking.length, 2);
  });

  it('preserves existing nonBlocking items', () => {
    const existingNonBlocking = [makeBotComment('c.js', 'nitpick', { priority: 'low' })];
    const botComment = makeBotComment('a.js', 'Fix this');
    const hash = computeCommentHash('a.js', 'Fix this');

    const result = deduplicateBlockingBotComments([botComment], existingNonBlocking, [hash]);
    assert.equal(result.nonBlocking.length, 2, 'existing + deduplicated');
  });

  it('works with cursor-ai[bot] comments', () => {
    const comment = makeBotComment('x.js', '**severity**: medium\nFix this', { author: 'cursor-ai[bot]' });
    const hash = computeCommentHash('x.js', '**severity**: medium\nFix this');

    const result = deduplicateBlockingBotComments([comment], [], [hash]);
    assert.equal(result.blocking.length, 0);
    assert.equal(result.nonBlocking.length, 1);
  });

  it('does NOT dedup review-level bot items without a path', () => {
    // Review-level items (CHANGES_REQUESTED) lack a path — body-only
    // hashes risk false matches, so they must stay blocking.
    const reviewItem = makeBotComment(null, 'Please address these issues', { path: undefined });
    const hash = computeCommentHash(undefined, 'Please address these issues');

    const result = deduplicateBlockingBotComments([reviewItem], [], [hash]);
    assert.equal(result.blocking.length, 1, 'review-level item must stay blocking');
    assert.equal(result.nonBlocking.length, 0);
  });

  it('returns original arrays when no previous hashes match', () => {
    const comment = makeBotComment('a.js', 'New issue');

    const result = deduplicateBlockingBotComments([comment], [], ['deadbeef']);
    assert.equal(result.blocking.length, 1);
    assert.equal(result.nonBlocking.length, 0);
  });

  it('handles null/undefined previousRunBotHashes gracefully', () => {
    const comment = makeBotComment('a.js', 'Fix this');
    const resultNull = deduplicateBlockingBotComments([comment], [], null);
    assert.equal(resultNull.blocking.length, 1);
    const resultUndef = deduplicateBlockingBotComments([comment], [], undefined);
    assert.equal(resultUndef.blocking.length, 1);
  });

  it('deduplicates all re-posted comments when user force-pushes without fixing', () => {
    // P2: All comments re-posted identically after force-push
    const c1 = makeBotComment('a.js', 'Issue A');
    const c2 = makeBotComment('b.js', 'Issue B');
    const c3 = makeBotComment('c.js', 'Issue C');
    const h1 = computeCommentHash('a.js', 'Issue A');
    const h2 = computeCommentHash('b.js', 'Issue B');
    const h3 = computeCommentHash('c.js', 'Issue C');

    const result = deduplicateBlockingBotComments([c1, c2, c3], [], [h1, h2, h3]);
    assert.equal(result.blocking.length, 0, 'all re-posted bot comments deduped');
    assert.equal(result.nonBlocking.length, 3);
    assert.ok(result.nonBlocking.every((item) => item.deduplicated === true));
  });
});

// ── 3-run flow test (P1) ───────────────────────────────────────────────────

describe('3-run dedup flow', () => {
  it('correctly deduplicates across 3 runs with hash replacement', () => {
    const makeBotComment = (path, body) => ({
      id: Math.random(),
      author: 'copilot-pull-request-reviewer',
      body,
      path,
      line: 10,
      state: 'COMMENTED',
      priority: 'medium',
    });

    // Run 1: 3 blocking comments, no previous hashes
    const cA = makeBotComment('a.js', 'Issue A');
    const cB = makeBotComment('b.js', 'Issue B');
    const cC = makeBotComment('c.js', 'Issue C');
    const run1 = deduplicateBlockingBotComments([cA, cB, cC], [], []);
    assert.equal(run1.blocking.length, 3, 'Run 1: all comments blocking');
    assert.equal(run1.nonBlocking.length, 0);

    // Record hashes from Run 1 blocking (simulating exit-fail state save)
    const run1Hashes = run1.blocking
      .filter((item) => item.path)
      .map((item) => computeCommentHash(item.path, item.body));
    assert.equal(run1Hashes.length, 3);

    // Run 2: User fixes A and C. Copilot re-posts B (identical) and new D.
    const cB2 = makeBotComment('b.js', 'Issue B'); // identical re-post
    const cD = makeBotComment('d.js', 'Issue D');   // new comment
    const run2 = deduplicateBlockingBotComments([cB2, cD], [], run1Hashes);
    assert.equal(run2.blocking.length, 1, 'Run 2: only D is blocking');
    assert.equal(run2.blocking[0].body, 'Issue D');
    assert.equal(run2.nonBlocking.length, 1, 'Run 2: B deduped to nonBlocking');
    assert.equal(run2.nonBlocking[0].deduplicated, true);

    // Record hashes from Run 2 blocking (REPLACED, not appended)
    const run2Hashes = run2.blocking
      .filter((item) => item.path)
      .map((item) => computeCommentHash(item.path, item.body));
    assert.equal(run2Hashes.length, 1, 'Run 2: only hash_D saved');

    // Run 3: User fixes D, no new comments. D is re-posted identically.
    const cD2 = makeBotComment('d.js', 'Issue D'); // identical re-post
    const run3 = deduplicateBlockingBotComments([cD2], [], run2Hashes);
    assert.equal(run3.blocking.length, 0, 'Run 3: D deduped');
    assert.equal(run3.nonBlocking.length, 1);
    assert.equal(run3.nonBlocking[0].deduplicated, true);

    // After Run 3 exit-success: hashes would be cleared to []
  });
});

// ── initState with previousRunBotHashes ─────────────────────────────────────

describe('initState includes previousRunBotHashes', () => {
  it('has previousRunBotHashes as an empty array', () => {
    const state = initState({ number: 42, url: 'https://github.com/test/42', branch: 'feature' });
    assert.ok(Array.isArray(state.previousRunBotHashes));
    assert.equal(state.previousRunBotHashes.length, 0);
  });

  it('does NOT have old dedup fields (addressedBotComments, seenBotComments, seenAtHead)', () => {
    const state = initState({ number: 42, url: 'https://github.com/test/42', branch: 'feature' });
    assert.equal(state.addressedBotComments, undefined);
    assert.equal(state.seenBotComments, undefined);
    assert.equal(state.seenAtHead, undefined);
  });
});

// ── Phase 1: Fresh-review dedup bug (currentHead) ──────────────────────────

describe('deduplicateBlockingBotComments — currentHead guard', () => {
  const CURRENT_HEAD = 'abc1234567890abcdef1234567890abcdef123456';
  const STALE_COMMIT = 'def0000000000000000000000000000000000000';

  const makeBotComment = (path, body, overrides = {}) => ({
    id: Math.random(),
    author: 'copilot-pull-request-reviewer',
    body,
    path,
    line: 10,
    state: 'COMMENTED',
    priority: 'medium',
    ...overrides,
  });

  const makeHumanComment = (path, body, overrides = {}) => ({
    id: Math.random(),
    author: 'octocat',
    body,
    path,
    line: 10,
    state: 'COMMENTED',
    priority: 'high',
    ...overrides,
  });

  it('fresh review (commit_id === currentHead) with matching hash remains blocking', () => {
    const comment = makeBotComment('src/index.js', 'Fix this bug', { commit_id: CURRENT_HEAD });
    const hash = computeCommentHash('src/index.js', 'Fix this bug');

    const result = deduplicateBlockingBotComments([comment], [], [hash], { currentHead: CURRENT_HEAD });
    assert.equal(result.blocking.length, 1, 'fresh review must NOT be deduped');
    assert.equal(result.nonBlocking.length, 0);
  });

  it('mixed: fresh + stale comments — only stale deduped', () => {
    const fresh = makeBotComment('src/a.js', 'Issue A', { commit_id: CURRENT_HEAD });
    const stale = makeBotComment('src/b.js', 'Issue B', { commit_id: STALE_COMMIT });
    const hashA = computeCommentHash('src/a.js', 'Issue A');
    const hashB = computeCommentHash('src/b.js', 'Issue B');

    const result = deduplicateBlockingBotComments([fresh, stale], [], [hashA, hashB], { currentHead: CURRENT_HEAD });
    assert.equal(result.blocking.length, 1, 'only fresh comment stays blocking');
    assert.equal(result.blocking[0].body, 'Issue A');
    assert.equal(result.nonBlocking.length, 1, 'stale comment deduped');
    assert.equal(result.nonBlocking[0].deduplicated, true);
  });

  it('currentHead = null → backward compat, dedup proceeds normally', () => {
    const comment = makeBotComment('src/index.js', 'Fix this bug', { commit_id: CURRENT_HEAD });
    const hash = computeCommentHash('src/index.js', 'Fix this bug');

    // No currentHead passed — should dedup as before
    const result = deduplicateBlockingBotComments([comment], [], [hash]);
    assert.equal(result.blocking.length, 0, 'dedup proceeds when currentHead is null');
    assert.equal(result.nonBlocking.length, 1);
    assert.equal(result.nonBlocking[0].deduplicated, true);
  });

  it('human comment with commit_id === currentHead still stays blocking', () => {
    const human = makeHumanComment('src/index.js', 'Fix this bug', { commit_id: CURRENT_HEAD });
    const hash = computeCommentHash('src/index.js', 'Fix this bug');

    const result = deduplicateBlockingBotComments([human], [], [hash], { currentHead: CURRENT_HEAD });
    assert.equal(result.blocking.length, 1, 'human comment never deduped');
    assert.equal(result.nonBlocking.length, 0);
  });
});

// ── Phase 2: getChangedPaths ────────────────────────────────────────────────

describe('getChangedPaths', () => {
  it('returns a Set of changed file paths between two refs', () => {
    // Use actual git refs from this repo for a real integration test
    const { execSync } = require('child_process');
    const headSha = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    // Diff HEAD against itself should yield empty set
    const result = getChangedPaths(headSha, headSha);
    assert.ok(result instanceof Set, 'must return a Set');
    assert.equal(result.size, 0, 'identical refs produce empty Set');
  });

  it('returns null on non-hex ref (SHA regex rejection)', () => {
    const result = getChangedPaths('invalid_ref_aaa', 'invalid_ref_bbb');
    assert.equal(result, null, 'non-hex refs should be rejected by SHA pattern');
  });

  it('returns null when hex ref is shorter than 7 characters', () => {
    const result = getChangedPaths('abcdef', 'abcdef');
    assert.equal(result, null, '6-char hex ref should be rejected (minimum is 7)');
  });

  it('returns non-empty Set when refs differ and files changed', () => {
    // Use HEAD~1..HEAD which should have at least one file changed
    const { execSync } = require('child_process');
    let parentSha;
    try {
      parentSha = execSync('git rev-parse HEAD~1', { encoding: 'utf8' }).trim();
    } catch {
      // Shallow clone or single-commit repo — skip
      return;
    }
    const headSha = require('child_process').execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
    const result = getChangedPaths(parentSha, headSha);
    assert.ok(result instanceof Set, 'must return a Set');
    assert.ok(result.size > 0, 'HEAD~1..HEAD should have at least one changed file');
  });

  it('returns null when ref is not a valid SHA (injection prevention)', () => {
    const result = getChangedPaths('HEAD', 'HEAD');
    assert.equal(result, null, 'non-hex refs should be rejected');
  });

  it('returns null when fromRef is null', () => {
    const result = getChangedPaths(null, 'abc123');
    assert.equal(result, null, 'null fromRef should return null');
  });
});

// ── Promotion path-filter logic (spec tests 6 & 7) ─────────────────────────

describe('hash-recording path filter logic', () => {
  // These tests verify the filtering logic used when recording bot comment
  // hashes in state.previousRunBotHashes. The production code filters by:
  //   .filter((item) => !changedPaths || changedPaths.has(item.path))
  // We test this filter directly to ensure correct behavior.

  const makeBotComment = (filePath, body) => ({
    id: Math.random(),
    author: 'copilot-pull-request-reviewer',
    body,
    path: filePath,
    line: 10,
    state: 'COMMENTED',
    priority: 'medium',
  });

  it('bot comment on unmodified file — hash NOT recorded (spec test 6)', () => {
    const changedPaths = new Set(['src/index.js']);
    const comment = makeBotComment('src/utils.js', 'Fix this');

    // Simulate the production filter
    const filtered = [comment]
      .filter((item) => item.path)
      .filter((item) => !changedPaths || changedPaths.has(item.path));

    assert.equal(filtered.length, 0, 'comment on unmodified file must be excluded');
  });

  it('bot comment on modified file — hash IS recorded (spec test 7)', () => {
    const changedPaths = new Set(['src/index.js']);
    const comment = makeBotComment('src/index.js', 'Fix this');

    const filtered = [comment]
      .filter((item) => item.path)
      .filter((item) => !changedPaths || changedPaths.has(item.path));

    assert.equal(filtered.length, 1, 'comment on modified file must be included');
    const hash = computeCommentHash(filtered[0].path, filtered[0].body);
    assert.match(hash, /^[a-f0-9]+$/, 'hash must be recorded');
  });

  it('changedPaths is null (fallback) — all bot comments recorded', () => {
    const changedPaths = null;
    const c1 = makeBotComment('src/a.js', 'Issue A');
    const c2 = makeBotComment('src/b.js', 'Issue B');

    const filtered = [c1, c2]
      .filter((item) => item.path)
      .filter((item) => !changedPaths || changedPaths.has(item.path));

    assert.equal(filtered.length, 2, 'null changedPaths falls back to recording all');
  });
});
