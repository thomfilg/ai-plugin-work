'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createDetectorRunner } = require('../createDetectorRunner');

function mk(hit) {
  return { detect: () => hit };
}

describe('createDetectorRunner', () => {
  it('rejects bad config', () => {
    assert.throws(() => createDetectorRunner({}), /missing "name"/);
    assert.throws(() => createDetectorRunner({ name: 'x' }), /detector.*detect/);
    assert.throws(
      () => createDetectorRunner({ name: 'x', detector: { detect: () => ({}) } }),
      /onHit/
    );
    assert.throws(
      () =>
        createDetectorRunner({
          name: 'x',
          detector: { detect: () => ({}) },
          onHit: () => {},
          requireRestartEligible: 'sometimes',
        }),
      /requireRestartEligible/
    );
  });

  it('phaseStall pattern: pre-detect guard, no short-circuit', () => {
    const calls = [];
    const runner = createDetectorRunner({
      name: 'phaseStall',
      detector: mk({ hit: true, elapsedMin: 99 }),
      requireRestartEligible: true,
      onHit: (ctx, hit) => calls.push(['hit', ctx.session, hit.elapsedMin]),
    });
    // Ineligible → guard short-circuits before detect
    assert.equal(runner({ session: 'GH-1-listen' }, false), false);
    assert.deepEqual(calls, []);
    // Eligible → onHit fires; returns false (no shortCircuit)
    assert.equal(runner({ session: 'GH-1-work' }, true), false);
    assert.deepEqual(calls, [['hit', 'GH-1-work', 99]]);
  });

  it('spinner pattern: short-circuit on handle, onMiss clears state', () => {
    const clears = [];
    let cooldownActive = false;
    const runner = createDetectorRunner({
      name: 'spinner',
      detector: mk({ hit: true, elapsedMin: 20, line: 'stuck' }),
      shortCircuit: true,
      onHit: (_ctx, _hit) => {
        if (cooldownActive) return false; // suppress within cooldown
        cooldownActive = true;
        return true; // halt remaining detectors
      },
      onMiss: (ctx) => clears.push(ctx.session),
    });
    assert.equal(runner({ session: 's1' }, false), true);
    assert.equal(runner({ session: 's1' }, false), false); // cooldown suppresses
    // Miss path
    const missRunner = createDetectorRunner({
      name: 'spinner',
      detector: mk({ hit: false }),
      shortCircuit: true,
      onHit: () => true,
      onMiss: (ctx) => clears.push(`miss:${ctx.session}`),
    });
    assert.equal(missRunner({ session: 's2' }, false), false);
    assert.deepEqual(clears, ['miss:s2']);
  });

  it('silence pattern: requireRestartEligible="after-hit" routes ineligible hits to onIneligibleHit', () => {
    const log = [];
    const runner = createDetectorRunner({
      name: 'silence',
      detector: mk({ hit: true, silenceSec: 600 }),
      requireRestartEligible: 'after-hit',
      shortCircuit: true,
      onHit: (ctx, hit) => {
        log.push(['restart', ctx.session, hit.silenceSec]);
        return true;
      },
      onIneligibleHit: (ctx) => log.push(['refresh-marker', ctx.session]),
    });
    // Eligible hit → onHit
    assert.equal(runner({ session: 'GH-1-work' }, true), true);
    // Ineligible hit → onIneligibleHit, NOT onHit, no short-circuit
    assert.equal(runner({ session: 'GH-1-listen' }, false), false);
    assert.deepEqual(log, [
      ['restart', 'GH-1-work', 600],
      ['refresh-marker', 'GH-1-listen'],
    ]);
  });

  it('prComments pattern: onMiss receives the full hit (reset flag flows through)', () => {
    const resets = [];
    const runner = createDetectorRunner({
      name: 'prComments',
      detector: mk({ hit: false, reset: true }),
      requireRestartEligible: true,
      onHit: () => {},
      onMiss: (ctx, hit) => {
        if (hit.reset) resets.push(ctx.ticket);
      },
    });
    runner({ ticket: 'GH-7', session: 'GH-7-work' }, true);
    assert.deepEqual(resets, ['GH-7']);
  });

  it('shortCircuit=false: onHit return value is ignored', () => {
    const runner = createDetectorRunner({
      name: 'commitStall',
      detector: mk({ hit: true }),
      requireRestartEligible: true,
      shortCircuit: false,
      onHit: () => true, // would short-circuit if allowed
    });
    assert.equal(runner({ session: 'x' }, true), false);
  });

  it('missing-hit detector returning undefined treated as no-hit, not crash', () => {
    const runner = createDetectorRunner({
      name: 'flaky',
      detector: { detect: () => undefined },
      onHit: () => {
        throw new Error('should not run');
      },
    });
    assert.equal(runner({}, true), false);
  });

  it('records __factoryMeta', () => {
    const runner = createDetectorRunner({
      name: 'spinner',
      detector: mk({ hit: false }),
      shortCircuit: true,
      requireRestartEligible: 'after-hit',
      onHit: () => {},
    });
    assert.deepEqual(runner.__factoryMeta, {
      kind: 'detector-runner',
      name: 'spinner',
      shortCircuit: true,
      requireRestartEligible: 'after-hit',
    });
  });
});
