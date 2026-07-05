'use strict';

// follow-up-pr-gh248.test.js — GH-248 acceptance criteria:
//  AC1  position-outdated comments are NOT auto-downgraded to low priority
//  AC2  they carry a display tag but keep their original classification
//  AC3  on exit, ALL comments (blocking + non-blocking) print FULL bodies
//  AC4  polling previews stay truncated (80 chars) — unchanged

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FOLLOW_UP_PR_PATH = path.resolve(__dirname, '..', 'follow-up-pr.js');
const SOURCE = fs.readFileSync(FOLLOW_UP_PR_PATH, 'utf8');
const { printExitCommentBodies } = require(FOLLOW_UP_PR_PATH);

function captureStdout(fn) {
  const lines = [];
  const original = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines.join('\n');
}

describe('GH-248/GH-249 — the script never pre-judges comment priority', () => {
  it('no longer downgrades position-outdated comments to low (source guard)', () => {
    assert.ok(
      !SOURCE.includes('if (isOutdated || isOldCommit)'),
      'the combined outdated||old-commit downgrade must be gone'
    );
    assert.ok(
      SOURCE.includes('item.positionOutdated = true'),
      'position-outdated comments must be tagged instead'
    );
  });

  it('GH-249: old-commit comments are no longer downgraded either — marker only', () => {
    assert.ok(
      !/isOldCommit[\s\S]{0,120}priority = 'low'/.test(SOURCE) &&
        !/branchCommits[\s\S]{0,160}priority = 'low'/.test(SOURCE),
      'no priority downgrade may remain in the stale-marker loop'
    );
    assert.ok(
      SOURCE.includes('display-only marker — priority unchanged (GH-249)'),
      'old-commit comments keep a display-only stale marker'
    );
  });

  it('polling display shows the (position outdated) tag', () => {
    assert.ok(SOURCE.includes('(position outdated)'));
  });
});

describe('GH-248 — full comment bodies on exit', () => {
  const longBody = `First line of a long review comment.\n${'x'.repeat(200)}\nLast line.`;
  const reviews = {
    blocking: [
      {
        author: 'cursor[bot]',
        priority: 'medium',
        path: 'src/a.js',
        line: 12,
        body: longBody,
        positionOutdated: true,
      },
    ],
    nonBlocking: [
      {
        author: 'copilot',
        priority: 'low',
        path: 'src/b.js',
        line: null,
        body: 'A non-blocking nitpick that must still be shown in full.',
        stale: true,
      },
    ],
  };

  it('prints every comment with its FULL body (no 80-char truncation)', () => {
    const out = captureStdout(() => printExitCommentBodies(reviews));
    assert.ok(out.includes('Full Comment Bodies'));
    assert.ok(out.includes('x'.repeat(200)), 'long body must not be truncated');
    assert.ok(out.includes('Last line.'), 'multi-line bodies print completely');
    assert.ok(out.includes('[BLOCKING]'));
    assert.ok(out.includes('[NON-BLOCKING]'));
    assert.ok(out.includes('non-blocking nitpick'), 'non-blocking comments included');
  });

  it('shows priority, location, and stale/position-outdated markers', () => {
    const out = captureStdout(() => printExitCommentBodies(reviews));
    assert.ok(out.includes('[MEDIUM]'));
    assert.ok(out.includes('src/a.js:12'));
    assert.ok(out.includes('(position outdated)'));
    assert.ok(out.includes('(stale)'));
  });

  it('prints nothing when there are no comments', () => {
    const out = captureStdout(() => printExitCommentBodies({ blocking: [], nonBlocking: [] }));
    assert.equal(out, '');
  });

  it('is invoked on exit-fail, recheck, success, and timeout paths (source guard)', () => {
    const calls = SOURCE.match(/printExitCommentBodies\(reviews\);/g) || [];
    assert.ok(calls.length >= 4, `expected >=4 exit-path calls, found ${calls.length}`);
  });

  it('polling previews remain truncated at 80 chars (AC4 unchanged)', () => {
    assert.ok(SOURCE.includes('slice(0, 77)'), 'polling preview truncation must remain');
  });
});
