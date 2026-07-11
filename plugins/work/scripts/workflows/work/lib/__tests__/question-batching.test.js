/**
 * Tests for lib/question-batching.js (GH-543) — the ≤4 AskUserQuestion
 * batch-cap helper shared by every question-gate delivery site.
 *
 * Run: node --test scripts/workflows/work/lib/__tests__/question-batching.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { MAX_PER_ASK, takeBatch } = require('../question-batching');

function makeQuestions(n) {
  return Array.from({ length: n }, (_, i) => ({
    questionText: `Q${i + 1}?`,
    applyKey: `Q${i + 1}?`,
  }));
}

/**
 * Simulate the driver loop: take a batch, resolve it (drop it from the
 * pending set), re-derive the rest. Returns the successive batch sizes.
 */
function batchSizes(n) {
  let pending = makeQuestions(n);
  const sizes = [];
  while (pending.length > 0) {
    const { batch } = takeBatch(pending);
    sizes.push(batch.length);
    pending = pending.slice(batch.length);
  }
  return sizes;
}

describe('question-batching takeBatch', () => {
  it('exports MAX_PER_ASK = 4 (mirrors the AskUserQuestion hard cap)', () => {
    assert.equal(MAX_PER_ASK, 4);
  });

  it('batches 5 questions as 4+1', () => {
    assert.deepEqual(batchSizes(5), [4, 1]);
  });

  it('batches 8 questions as 4+4', () => {
    assert.deepEqual(batchSizes(8), [4, 4]);
  });

  it('batches 9 questions as 4+4+1', () => {
    assert.deepEqual(batchSizes(9), [4, 4, 1]);
  });

  it('never emits a batch larger than 4', () => {
    for (let n = 0; n <= 23; n++) {
      const { batch } = takeBatch(makeQuestions(n));
      assert.ok(batch.length <= MAX_PER_ASK, `n=${n} produced a batch of ${batch.length}`);
    }
  });

  it('preserves input order and slices from the front (restart-resume invariant)', () => {
    const qs = makeQuestions(9);
    const a = takeBatch(qs);
    const b = takeBatch(qs);
    assert.deepEqual(a.batch, qs.slice(0, 4), 'batch must be the front slice, in order');
    assert.deepEqual(a.batch, b.batch, 'same input must re-derive the identical batch');
  });

  it('reports total/thisBatch/remaining arithmetic over the pending set', () => {
    const { batch, total, remaining } = takeBatch(makeQuestions(9));
    assert.equal(total, 9);
    assert.equal(batch.length, 4);
    assert.equal(remaining, 5);
  });

  it('batchNumber/totalBatches are remaining-set-relative: 9 questions render 1/3 → 1/2 → 1/1', () => {
    let pending = makeQuestions(9);
    const rendered = [];
    while (pending.length > 0) {
      const { batch, batchNumber, totalBatches } = takeBatch(pending);
      rendered.push(`${batchNumber}/${totalBatches}`);
      pending = pending.slice(batch.length);
    }
    assert.deepEqual(rendered, ['1/3', '1/2', '1/1']);
  });

  it('delivers a ≤4 set whole: total==thisBatch, remaining 0, one batch', () => {
    const { batch, total, remaining, batchNumber, totalBatches } = takeBatch(makeQuestions(3));
    assert.equal(batch.length, 3);
    assert.equal(total, 3);
    assert.equal(remaining, 0);
    assert.equal(batchNumber, 1);
    assert.equal(totalBatches, 1);
  });

  it('returns an empty batch for empty or non-array input', () => {
    for (const input of [[], null, undefined, 'nope', 42]) {
      const res = takeBatch(input);
      assert.deepEqual(res.batch, []);
      assert.equal(res.total, 0);
      assert.equal(res.remaining, 0);
    }
  });
});
