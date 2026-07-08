'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const MODULE_PATH = path.resolve(__dirname, '..', 'replay-judge-batch.js');

function load() {
  // eslint-disable-next-line global-require
  return require(MODULE_PATH);
}

test('exports JUDGE_BATCH_SIZE and JUDGE_SYSTEM_PROMPT as non-empty constants', () => {
  const mod = load();
  assert.equal(typeof mod.JUDGE_BATCH_SIZE, 'number');
  assert.ok(mod.JUDGE_BATCH_SIZE > 0, 'JUDGE_BATCH_SIZE must be > 0');
  assert.equal(typeof mod.JUDGE_SYSTEM_PROMPT, 'string');
  assert.ok(mod.JUDGE_SYSTEM_PROMPT.length > 0, 'JUDGE_SYSTEM_PROMPT must be non-empty');
});

test('buildBatchInput clips prompt to 600 chars and matched to 200 chars', () => {
  const { buildBatchInput } = load();
  const longPrompt = 'p'.repeat(2000);
  const longMatched = 'm'.repeat(2000);
  const tuples = [
    { memory: 'mem-a', body: 'body-a', prompt: longPrompt, matched: longMatched },
  ];
  const out = buildBatchInput(tuples);
  assert.equal(out.length, 1);
  assert.equal(out[0].memory, 'mem-a');
  assert.equal(out[0].body, 'body-a');
  assert.ok(out[0].prompt.length <= 600, `prompt length ${out[0].prompt.length} > 600`);
  assert.ok(out[0].matched.length <= 200, `matched length ${out[0].matched.length} > 200`);
});

test('buildBatchInput preserves order and memory/body of every entry', () => {
  const { buildBatchInput } = load();
  const tuples = [
    { memory: 'm1', body: 'b1', prompt: 'p1', matched: 'x1' },
    { memory: 'm2', body: 'b2', prompt: 'p2', matched: 'x2' },
    { memory: 'm3', body: 'b3', prompt: 'p3', matched: 'x3' },
  ];
  const out = buildBatchInput(tuples);
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((o) => o.memory), ['m1', 'm2', 'm3']);
  assert.deepEqual(out.map((o) => o.body), ['b1', 'b2', 'b3']);
});

test('parseBatchOutput round-trips a well-formed yes/no array', () => {
  const { parseBatchOutput } = load();
  const input = [
    { memory: 'm1', body: 'b1', prompt: 'p1', matched: 'x1' },
    { memory: 'm2', body: 'b2', prompt: 'p2', matched: 'x2' },
  ];
  const raw = JSON.stringify([
    { memory: 'm1', relevant: 'yes' },
    { memory: 'm2', relevant: 'no' },
  ]);
  const out = parseBatchOutput(raw, input);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { memory: 'm1', relevant: 'yes' });
  assert.deepEqual(out[1], { memory: 'm2', relevant: 'no' });
});

test('parseBatchOutput marks judge-failed on malformed JSON', () => {
  const { parseBatchOutput } = load();
  const input = [
    { memory: 'm1', body: 'b1', prompt: 'p1', matched: 'x1' },
    { memory: 'm2', body: 'b2', prompt: 'p2', matched: 'x2' },
  ];
  const out = parseBatchOutput('{not json at all', input);
  assert.equal(out.length, 2);
  assert.equal(out[0].relevant, 'judge-failed');
  assert.equal(out[1].relevant, 'judge-failed');
  assert.equal(out[0].memory, 'm1');
  assert.equal(out[1].memory, 'm2');
});

test('parseBatchOutput marks judge-failed on length mismatch', () => {
  const { parseBatchOutput } = load();
  const input = [
    { memory: 'm1', body: 'b1', prompt: 'p1', matched: 'x1' },
    { memory: 'm2', body: 'b2', prompt: 'p2', matched: 'x2' },
  ];
  const raw = JSON.stringify([{ memory: 'm1', relevant: 'yes' }]);
  const out = parseBatchOutput(raw, input);
  assert.equal(out.length, 2);
  assert.equal(out[0].relevant, 'judge-failed');
  assert.equal(out[1].relevant, 'judge-failed');
});

test('parseBatchOutput marks judge-failed for entry missing relevant key', () => {
  const { parseBatchOutput } = load();
  const input = [
    { memory: 'm1', body: 'b1', prompt: 'p1', matched: 'x1' },
    { memory: 'm2', body: 'b2', prompt: 'p2', matched: 'x2' },
  ];
  const raw = JSON.stringify([
    { memory: 'm1', relevant: 'yes' },
    { memory: 'm2' },
  ]);
  const out = parseBatchOutput(raw, input);
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { memory: 'm1', relevant: 'yes' });
  assert.equal(out[1].relevant, 'judge-failed');
  assert.equal(out[1].memory, 'm2');
});

test('sampleForCap returns extrapolated:false when tuples.length <= cap', () => {
  const { sampleForCap } = load();
  const tuples = [{ memory: 'a' }, { memory: 'b' }, { memory: 'c' }];
  const out = sampleForCap(tuples, 10);
  assert.equal(out.extrapolated, false);
  assert.equal(out.sampled.length, 3);
  assert.deepEqual(out.sampled.map((s) => s.memory), ['a', 'b', 'c']);
});

test('sampleForCap returns extrapolated:true and sampled.length === cap when tuples.length > cap', () => {
  const { sampleForCap } = load();
  const tuples = Array.from({ length: 50 }, (_, i) => ({ memory: `m${i}` }));
  const out = sampleForCap(tuples, 10);
  assert.equal(out.extrapolated, true);
  assert.equal(out.sampled.length, 10);
});
