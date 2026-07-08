'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { validateRegistry } = require('../validateRegistry');

function fn(meta) {
  const f = () => undefined;
  if (meta) f.__factoryMeta = meta;
  return f;
}

describe('validateRegistry', () => {
  it('accepts a clean registry with linear-forward + backward edges', () => {
    const r = validateRegistry({
      STEPS: { a: 'a', b: 'b', c: 'c' },
      STEP_ORDER: ['a', 'b', 'c'],
      STEP_TRANSITIONS: { a: ['b'], b: ['c'], c: ['b', 'c'] }, // c→b backward, c→c terminal-self
      STEP_PIPELINE: [fn({ id: 'a', retryTo: null }), fn({ id: 'b', retryTo: null }), fn()],
    });
    assert.equal(r.valid, true, r.errors.join('\n'));
  });

  it('R1: catches STEPS entry missing from STEP_ORDER', () => {
    const r = validateRegistry({ STEPS: { a: 'a', b: 'b' }, STEP_ORDER: ['a'] });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /STEPS has "b"/.test(e)));
  });

  it('R3: rejects forward-skip edges', () => {
    const r = validateRegistry({
      STEPS: { a: 'a', b: 'b', c: 'c' },
      STEP_ORDER: ['a', 'b', 'c'],
      STEP_TRANSITIONS: { a: ['c'] }, // skips b
    });
    assert.equal(r.valid, false);
    assert.ok(
      r.errors.some((e) => /neither a linear-forward, backward, nor terminal-self/.test(e))
    );
  });

  it('R3: rejects forward-jump (non-adjacent) edges', () => {
    const r = validateRegistry({
      STEPS: { a: 'a', b: 'b' },
      STEP_ORDER: ['a', 'b'],
      STEP_TRANSITIONS: { a: ['b', 'a'] }, // a→a is self on non-terminal
    });
    assert.equal(r.valid, false);
  });

  it('R3: allows terminal self-loop (complete → complete)', () => {
    const r = validateRegistry({
      STEPS: { a: 'a', b: 'b' },
      STEP_ORDER: ['a', 'b'],
      STEP_TRANSITIONS: { a: ['b'], b: ['b'] },
    });
    assert.equal(r.valid, true, r.errors.join('\n'));
  });

  it('R5: catches retryTo declared in meta but missing from STEP_TRANSITIONS', () => {
    const r = validateRegistry({
      STEPS: { a: 'a', b: 'b' },
      STEP_ORDER: ['a', 'b'],
      STEP_TRANSITIONS: { a: ['b'] },
      STEP_PIPELINE: [fn(), fn({ id: 'b', retryTo: 'a' })],
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /retryTo="a"/.test(e)));
  });

  it('R6: catches duplicates in STEP_ORDER', () => {
    const r = validateRegistry({ STEPS: { a: 'a' }, STEP_ORDER: ['a', 'a'] });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /duplicate step "a"/.test(e)));
  });

  it('hand-written steps (no __factoryMeta) are permitted', () => {
    const r = validateRegistry({
      STEPS: { a: 'a', b: 'b' },
      STEP_ORDER: ['a', 'b'],
      STEP_TRANSITIONS: { a: ['b'] },
      STEP_PIPELINE: [fn(), fn()],
    });
    assert.equal(r.valid, true);
  });

  it('validates the real /work step registry', () => {
    const registryPath = path.resolve(
      __dirname,
      '../../../plugins/work/scripts/workflows/work/step-registry.js'
    );
    const pipelinePath = path.resolve(
      __dirname,
      '../../../plugins/work/scripts/workflows/work/steps/index.js'
    );
    if (!fs.existsSync(registryPath) || !fs.existsSync(pipelinePath)) {
      // Factories are stand-alone; if the plugin tree is absent, skip.
      return;
    }
    const reg = require(registryPath);
    const { STEP_PIPELINE } = require(pipelinePath);
    const result = validateRegistry({
      STEPS: reg.STEPS,
      STEP_ORDER: reg.STEP_ORDER,
      STEP_TRANSITIONS: reg.STEP_TRANSITIONS,
      STEP_PIPELINE,
    });
    assert.equal(result.valid, true, result.errors.join('\n'));
  });
});
