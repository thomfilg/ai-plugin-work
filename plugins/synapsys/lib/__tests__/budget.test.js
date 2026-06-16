'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { demoteToFit, SKIP_DEMOTION_BELOW_DEFAULT } = require('../budget');

function makeEntry(name, fullLen, summaryLen) {
  return {
    memory: { name },
    initialKind: 'full',
    finalKind: 'full',
    fullText: 'F'.repeat(fullLen),
    summaryText: 'S'.repeat(summaryLen),
  };
}

function totalSize(entries, sep) {
  const rendered = entries.map((e) =>
    e.finalKind === 'full' ? e.fullText.length : e.summaryText.length
  );
  if (rendered.length === 0) return 0;
  return rendered.reduce((a, b) => a + b, 0) + sep.length * (rendered.length - 1);
}

test('SKIP_DEMOTION_BELOW_DEFAULT exported as 2000', () => {
  assert.equal(SKIP_DEMOTION_BELOW_DEFAULT, 2000);
});

test('no-op when total is already under the limit', () => {
  const entries = [makeEntry('a', 3000, 50), makeEntry('b', 4000, 50), makeEntry('c', 2500, 50)];
  const sep = '\n\n';
  const result = demoteToFit(entries, { limit: 16000, sep, skipBelow: 2000 });
  assert.equal(result.length, 3);
  for (const e of result) {
    assert.equal(e.finalKind, 'full');
  }
});

test('reverse-walk order: demotes from last to first', () => {
  const entries = [makeEntry('m1', 7000, 50), makeEntry('m2', 7000, 50), makeEntry('m3', 7000, 50)];
  const sep = '\n\n';
  const result = demoteToFit(entries, { limit: 16000, sep, skipBelow: 2000 });
  // total full = 21000+4 = 21004; demote m3 → 14000+50+4 = 14054 ≤ 16000
  assert.equal(result[0].finalKind, 'full', 'm1 should remain full');
  assert.equal(result[1].finalKind, 'full', 'm2 should remain full');
  assert.equal(result[2].finalKind, 'reminder', 'm3 should be demoted first');
});

test('skip threshold: entries with fullText.length < skipBelow are never demoted', () => {
  const entries = [makeEntry('big', 9000, 50), makeEntry('tiny', 1500, 50)];
  const sep = '\n\n';
  // total = 9000 + 1500 + 2 = 10502 ≤ 16000 → no demotion needed
  // Force an overflow by using a small limit
  const result = demoteToFit(entries, { limit: 8000, sep, skipBelow: 2000 });
  // tiny is below skipBelow and must NOT be demoted.
  // big is the only demotable, but it's the last remaining full → rotation guarantee prevents demotion.
  assert.equal(result[1].finalKind, 'full', 'tiny under skipBelow must stay full');
  assert.equal(result[0].finalKind, 'full', 'big must stay full (terminal rotation guarantee)');
});

test('terminal rotation guarantee: never demote the last remaining full entry', () => {
  const entries = [makeEntry('only', 20000, 50)];
  const sep = '\n\n';
  const result = demoteToFit(entries, { limit: 16000, sep, skipBelow: 2000 });
  assert.equal(result[0].finalKind, 'full', 'single oversized entry must stay full');
});

test('worked example: 8000,6000,6000,1000,5000 → full,full,reminder,full,reminder', () => {
  const entries = [
    makeEntry('a', 8000, 50),
    makeEntry('b', 6000, 50),
    makeEntry('c', 6000, 50),
    makeEntry('d', 1000, 50),
    makeEntry('e', 5000, 50),
  ];
  const sep = '\n\n';
  const result = demoteToFit(entries, { limit: 16000, sep, skipBelow: 2000 });
  assert.equal(result[0].finalKind, 'full', 'a stays full');
  assert.equal(result[1].finalKind, 'full', 'b stays full');
  assert.equal(result[2].finalKind, 'reminder', 'c demoted');
  assert.equal(result[3].finalKind, 'full', 'd skipped (under threshold)');
  assert.equal(result[4].finalKind, 'reminder', 'e demoted first (reverse walk)');
  assert.ok(totalSize(result, sep) <= 16000, 'final total must fit under limit');
});
