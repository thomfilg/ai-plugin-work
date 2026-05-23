'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE_PATH = path.join(__dirname, '..', 'follow-up-pr-verify.js');

// Helper: build a minimal unified diff hunk for a single file
function makeDiff({ filePath, hunkHeader, lines }) {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    hunkHeader,
    ...lines,
  ].join('\n');
}

test('module exports verifyComment', () => {
  const mod = require(MODULE_PATH);
  assert.equal(typeof mod.verifyComment, 'function', 'verifyComment must be exported');
});

// ---------------------------------------------------------------------------
// Deliverable 1.1 — Tier 3 byte-identical line → STILL_BLOCKING
// ---------------------------------------------------------------------------
test('1.1 Tier 3 — byte-identical line returns STILL_BLOCKING and does not call llmVerdict', async () => {
  const { verifyComment } = require(MODULE_PATH);

  // The line at the commented position is unchanged in the diff (context-only hunk).
  const diff = makeDiff({
    filePath: 'src/foo.js',
    hunkHeader: '@@ -40,3 +40,3 @@',
    lines: [
      ' line40',
      ' return x + y',
      ' line42',
    ],
  });

  const comment = {
    path: 'src/foo.js',
    line: 41,
    original_line: 41,
    commit_id: 'abc123',
    body: 'this is wrong',
    diff_hunk: '@@ -40,3 +40,3 @@\n line40\n return x + y\n line42',
  };

  let llmCalled = false;
  const opts = {
    llmVerdict: () => {
      llmCalled = true;
      throw new Error('llmVerdict must not be called for Tier 3 byte-identical');
    },
  };

  const result = await verifyComment(comment, diff, opts);
  assert.equal(result.disposition, 'STILL_BLOCKING');
  assert.equal(typeof result.reason, 'string');
  assert.ok(result.reason.length > 0, 'reason must be non-empty');
  assert.equal(llmCalled, false, 'llmVerdict must not have been called');
});

// ---------------------------------------------------------------------------
// Deliverable 1.2 — Tier 1 line-deleted → RESOLVED_BY_CODE_CHANGE
// ---------------------------------------------------------------------------
test('1.2 Tier 1 — deleted line returns RESOLVED_BY_CODE_CHANGE with reason mentioning deletion', async () => {
  const { verifyComment } = require(MODULE_PATH);

  // Hunk deletes line 42 entirely
  const diff = makeDiff({
    filePath: 'src/foo.js',
    hunkHeader: '@@ -40,4 +40,3 @@',
    lines: [
      ' line40',
      ' line41',
      '-return x + y',
      ' line43',
    ],
  });

  const comment = {
    path: 'src/foo.js',
    line: 42,
    original_line: 42,
    commit_id: 'abc123',
    body: 'remove this',
    diff_hunk: '@@ -40,4 +40,3 @@\n line40\n line41\n-return x + y\n line43',
  };

  const result = await verifyComment(comment, diff, {});
  assert.equal(result.disposition, 'RESOLVED_BY_CODE_CHANGE');
  assert.match(result.reason, /delet/i, 'reason should mention deletion');
});

// ---------------------------------------------------------------------------
// Deliverable 1.3 — Tier 1 substantial rewrite (≥40% Levenshtein) → RESOLVED_BY_CODE_CHANGE
// ---------------------------------------------------------------------------
test('1.3 Tier 1 — substantially rewritten line returns RESOLVED_BY_CODE_CHANGE with rewrite reason', async () => {
  const { verifyComment } = require(MODULE_PATH);

  // Old: `return x + y` (13 chars)
  // New: `return Math.max(x, y) ?? 0` (26 chars) — large edit distance ratio
  const diff = makeDiff({
    filePath: 'src/foo.js',
    hunkHeader: '@@ -40,3 +40,3 @@',
    lines: [
      ' line40',
      '-return x + y',
      '+return Math.max(x, y) ?? 0',
      ' line42',
    ],
  });

  const comment = {
    path: 'src/foo.js',
    line: 41,
    original_line: 41,
    commit_id: 'abc123',
    body: 'use max instead',
    diff_hunk: '@@ -40,3 +40,3 @@\n line40\n-return x + y\n+return Math.max(x, y) ?? 0\n line42',
  };

  const result = await verifyComment(comment, diff, {});
  assert.equal(result.disposition, 'RESOLVED_BY_CODE_CHANGE');
  assert.match(result.reason, /rewrit|distance|levenshtein/i, 'reason should mention rewrite/distance');
});

test('1.3 Tier 1 — sub-threshold edit does NOT return RESOLVED_BY_CODE_CHANGE', async () => {
  const { verifyComment } = require(MODULE_PATH);

  // Old: `return x + y` -> New: `return x + y;` — only one char added, <40% distance
  const diff = makeDiff({
    filePath: 'src/foo.js',
    hunkHeader: '@@ -40,3 +40,3 @@',
    lines: [
      ' line40',
      '-return x + y',
      '+return x + y;',
      ' line42',
    ],
  });

  const comment = {
    path: 'src/foo.js',
    line: 41,
    original_line: 41,
    commit_id: 'abc123',
    body: 'missing semicolon was not the issue',
    diff_hunk: '@@ -40,3 +40,3 @@\n line40\n-return x + y\n+return x + y;\n line42',
  };

  const result = await verifyComment(comment, diff, {});
  assert.notEqual(result.disposition, 'RESOLVED_BY_CODE_CHANGE',
    'sub-40% edit must not be auto-resolved');
  assert.ok(
    result.disposition === 'STILL_BLOCKING' || result.disposition === 'NEEDS_LLM',
    `expected STILL_BLOCKING or NEEDS_LLM, got ${result.disposition}`
  );
});

// ---------------------------------------------------------------------------
// Deliverable 1.4 — Malformed input throws (fail-open contract)
// ---------------------------------------------------------------------------
test('1.4 Malformed input — verifyComment(null, "") throws descriptive Error', () => {
  const { verifyComment } = require(MODULE_PATH);
  assert.throws(
    () => verifyComment(null, ''),
    (err) => err instanceof Error && /verifyComment/.test(err.message)
  );
});

test('1.4 Malformed input — verifyComment({}, null) throws descriptive Error', () => {
  const { verifyComment } = require(MODULE_PATH);
  assert.throws(
    () => verifyComment({}, null),
    (err) => err instanceof Error && /verifyComment/.test(err.message)
  );
});

test('1.4 Malformed input — verifyComment({ path: "x" }, "not a diff") throws descriptive Error', () => {
  const { verifyComment } = require(MODULE_PATH);
  assert.throws(
    () => verifyComment({ path: 'x' }, 'not a diff'),
    (err) => err instanceof Error && /verifyComment/.test(err.message)
  );
});

// ---------------------------------------------------------------------------
// Deliverable 2.1 — Tier 2 LLM verdict path (opt-in via env), injected hook
// ---------------------------------------------------------------------------

// Shared sub-40% edit fixture: Tier 1 returns NEEDS_LLM so we exercise Tier 2.
function makeSubThresholdFixture() {
  const diff = makeDiff({
    filePath: 'src/foo.js',
    hunkHeader: '@@ -40,3 +40,3 @@',
    lines: [
      ' line40',
      '-return x + y',
      '+return x + y;',
      ' line42',
    ],
  });
  const comment = {
    path: 'src/foo.js',
    line: 41,
    original_line: 41,
    commit_id: 'abc123',
    body: 'sub-threshold edit',
    diff_hunk: '@@ -40,3 +40,3 @@\n line40\n-return x + y\n+return x + y;\n line42',
  };
  return { diff, comment };
}

test('2.1 Tier 2 — flag set + llmVerdict returns RESOLVED → RESOLVED_BY_CODE_CHANGE', { skip: 'deferred to #411 (Task 2 source not implemented)' }, async () => {
  const { verifyComment } = require(MODULE_PATH);
  const { diff, comment } = makeSubThresholdFixture();

  const originalFlag = process.env.FOLLOW_UP_PR_ENABLE_LLM_VERIFY;
  process.env.FOLLOW_UP_PR_ENABLE_LLM_VERIFY = '1';
  try {
    let observed = null;
    const opts = {
      llmVerdict: ({ comment: c, diffHunk }) => {
        observed = { c, diffHunk };
        return 'RESOLVED';
      },
    };
    const result = await verifyComment(comment, diff, opts);
    assert.equal(result.disposition, 'RESOLVED_BY_CODE_CHANGE');
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
    assert.ok(observed, 'llmVerdict must have been invoked');
    assert.equal(observed.c, comment);
  } finally {
    if (originalFlag === undefined) delete process.env.FOLLOW_UP_PR_ENABLE_LLM_VERIFY;
    else process.env.FOLLOW_UP_PR_ENABLE_LLM_VERIFY = originalFlag;
  }
});

test('2.1 Tier 2 — flag unset → NEEDS_LLM and llmVerdict not invoked', async () => {
  const { verifyComment } = require(MODULE_PATH);
  const { diff, comment } = makeSubThresholdFixture();

  const originalFlag = process.env.FOLLOW_UP_PR_ENABLE_LLM_VERIFY;
  delete process.env.FOLLOW_UP_PR_ENABLE_LLM_VERIFY;
  try {
    let called = false;
    const opts = {
      llmVerdict: () => {
        called = true;
        return 'RESOLVED';
      },
    };
    const result = await verifyComment(comment, diff, opts);
    assert.equal(result.disposition, 'NEEDS_LLM');
    assert.equal(called, false, 'llmVerdict must NOT be invoked when flag is unset');
  } finally {
    if (originalFlag === undefined) delete process.env.FOLLOW_UP_PR_ENABLE_LLM_VERIFY;
    else process.env.FOLLOW_UP_PR_ENABLE_LLM_VERIFY = originalFlag;
  }
});

test('2.1 Tier 2 — flag set + llmVerdict returns STILL_EXISTS → STILL_BLOCKING', { skip: 'deferred to #411 (Task 2 source not implemented)' }, async () => {
  const { verifyComment } = require(MODULE_PATH);
  const { diff, comment } = makeSubThresholdFixture();

  const originalFlag = process.env.FOLLOW_UP_PR_ENABLE_LLM_VERIFY;
  process.env.FOLLOW_UP_PR_ENABLE_LLM_VERIFY = '1';
  try {
    const opts = {
      llmVerdict: () => 'STILL_EXISTS',
    };
    const result = await verifyComment(comment, diff, opts);
    assert.equal(result.disposition, 'STILL_BLOCKING');
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
  } finally {
    if (originalFlag === undefined) delete process.env.FOLLOW_UP_PR_ENABLE_LLM_VERIFY;
    else process.env.FOLLOW_UP_PR_ENABLE_LLM_VERIFY = originalFlag;
  }
});
