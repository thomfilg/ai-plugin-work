'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { formatBlock } = require('../lib/cortex-format.js');

/**
 * Build a result entry of the documented shape
 * `{ id, savedAt, title, body, ageDays }`.
 */
function makeResult(overrides = {}) {
  return {
    id: 'mem-1',
    savedAt: '2026-06-05T00:00:00.000Z',
    title: 'Stacked PR rebase',
    body: 'Rebase the lower branch first, then restack the upper.',
    ageDays: 5,
    ...overrides,
  };
}

// --- Deliverable 5.1: header + per-result line schema ---------------------

test('formatBlock renders the [cortex:auto-recall] header', () => {
  const out = formatBlock({
    queries: [{ query: 'GH-519', projectId: 'claude-plugin-work', results: [makeResult()] }],
    maxAgeDays: 180,
    maxChars: 500,
  });
  assert.match(out, /\[cortex:auto-recall\]/, 'output contains the header marker');
});

test('formatBlock renders one result line per memory with the documented schema', () => {
  const out = formatBlock({
    queries: [
      {
        query: 'GH-519',
        projectId: 'claude-plugin-work',
        results: [
          makeResult({ id: 'mem-1', savedAt: '2026-06-05T00:00:00.000Z', title: 'First', body: 'body one', ageDays: 5 }),
          makeResult({ id: 'mem-2', savedAt: '2026-06-01T00:00:00.000Z', title: 'Second', body: 'body two', ageDays: 9 }),
        ],
      },
    ],
    maxAgeDays: 180,
    maxChars: 500,
  });
  const lines = out.split('\n').filter((l) => l.startsWith('- '));
  assert.equal(lines.length, 2, 'two result lines rendered');
});

test('formatBlock result line matches `- {id} (saved YYYY-MM-DD, {age}) — {title} :: {body}`', () => {
  const out = formatBlock({
    queries: [
      {
        query: 'GH-519',
        projectId: 'claude-plugin-work',
        results: [makeResult({ id: 'mem-7', savedAt: '2026-06-05T00:00:00.000Z', title: 'Title here', body: 'Body here', ageDays: 5 })],
      },
    ],
    maxAgeDays: 180,
    maxChars: 500,
  });
  const line = out.split('\n').find((l) => l.startsWith('- '));
  assert.ok(line, 'a result line exists');
  assert.match(line, /^- mem-7 \(saved 2026-06-05, .*\) — Title here :: Body here$/);
});

test('formatBlock renders a relative-age annotation inline', () => {
  const out = formatBlock({
    queries: [
      {
        query: 'GH-519',
        projectId: 'claude-plugin-work',
        results: [makeResult({ ageDays: 5 })],
      },
    ],
    maxAgeDays: 180,
    maxChars: 500,
  });
  const line = out.split('\n').find((l) => l.startsWith('- '));
  assert.match(line, /5 days ago/, 'relative age "5 days ago" appears in the line');
});

// --- Deliverable 5.2: empty marker + truncation + stale filter ------------

test('formatBlock emits the empty-result marker ending in → no matches', () => {
  const out = formatBlock({
    queries: [{ query: 'nothing here', projectId: 'claude-plugin-work', results: [] }],
    maxAgeDays: 180,
    maxChars: 500,
  });
  assert.match(
    out,
    /\[cortex:auto-recall\] query="nothing here" projectId="claude-plugin-work" → no matches/,
    'empty query renders the documented no-matches marker line',
  );
});

test('formatBlock hard-cuts a body longer than maxChars with a … suffix at exactly maxChars', () => {
  const maxChars = 10;
  const body = 'abcdefghijklmnopqrstuvwxyz'; // 26 chars, far longer than maxChars
  const out = formatBlock({
    queries: [
      {
        query: 'GH-519',
        projectId: 'claude-plugin-work',
        results: [makeResult({ body, ageDays: 1 })],
      },
    ],
    maxAgeDays: 180,
    maxChars,
  });
  const line = out.split('\n').find((l) => l.startsWith('- '));
  const bodyPart = line.split(' :: ')[1];
  assert.equal(bodyPart.length, maxChars, 'truncated body is exactly maxChars long including the … suffix');
  assert.ok(bodyPart.endsWith('…'), 'truncated body ends with the … suffix');
  assert.equal(bodyPart, 'abcdefghi…', 'body hard-cut to maxChars-1 visible chars plus …');
});

test('formatBlock does not truncate a body shorter than maxChars', () => {
  const out = formatBlock({
    queries: [
      {
        query: 'GH-519',
        projectId: 'claude-plugin-work',
        results: [makeResult({ body: 'short', ageDays: 1 })],
      },
    ],
    maxAgeDays: 180,
    maxChars: 500,
  });
  const line = out.split('\n').find((l) => l.startsWith('- '));
  const bodyPart = line.split(' :: ')[1];
  assert.equal(bodyPart, 'short', 'short body is left intact with no … suffix');
});

test('formatBlock excludes results older than maxAgeDays and keeps fresh ones', () => {
  const out = formatBlock({
    queries: [
      {
        query: 'GH-519',
        projectId: 'claude-plugin-work',
        results: [
          makeResult({ id: 'fresh', title: 'Fresh', body: 'fresh body', ageDays: 5 }),
          makeResult({ id: 'stale', title: 'Stale', body: 'stale body', ageDays: 200 }),
        ],
      },
    ],
    maxAgeDays: 180,
    maxChars: 500,
  });
  assert.match(out, /fresh/, 'the 5-day result is kept');
  assert.match(out, /5 days ago/, 'kept result shows its relative-age annotation');
  assert.doesNotMatch(out, /stale/, 'the 200-day result (> maxAgeDays) is excluded');
});

test('formatBlock renders → no matches when every result is filtered out as stale', () => {
  const out = formatBlock({
    queries: [
      {
        query: 'GH-519',
        projectId: 'claude-plugin-work',
        results: [makeResult({ id: 'stale', ageDays: 365 })],
      },
    ],
    maxAgeDays: 180,
    maxChars: 500,
  });
  assert.match(out, /→ no matches/, 'a query whose results are all stale renders the no-matches marker');
});
