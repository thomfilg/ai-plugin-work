'use strict';

/**
 * Unit tests for the pure verdict engine (GH-755) — edge cases the replay
 * corpus does not pin: tautology and base-setup flags, coverage thresholds,
 * unknown-kind fail-closed profile, and the kind-profile table shape.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { evaluate } = require('../verdict-engine');
const { profileFor, KIND_PROFILES } = require('../kind-profiles');
const { VERDICTS, TASK_KINDS } = require('../../lib/outcome-verdicts');

function baseObservations(overrides = {}) {
  return {
    diff: {
      empty: false,
      filesChanged: ['src/a.js', 'src/__tests__/a.test.js'],
      scopeGlobs: ['src/**'],
      outOfScope: [],
      ...overrides.diff,
    },
    deliverables: { promised: [], missing: [], ...overrides.deliverables },
    baseRun: {
      attempted: true,
      supported: true,
      outcome: 'fail',
      testsRan: 2,
      failures: 2,
      ...overrides.baseRun,
    },
    headRun: {
      attempted: true,
      supported: true,
      outcome: 'pass',
      testsRan: 2,
      failures: 0,
      exitCode: 0,
      reporterKind: 'structured',
      ...overrides.headRun,
    },
    coverage: { supported: false, changedLineCoveragePct: null, ...overrides.coverage },
  };
}

describe('verdict-engine (GH-755) — flags and thresholds', () => {
  it('happy path is VERIFIED with no flags', () => {
    const r = evaluate(baseObservations(), 'tdd-code');
    assert.equal(r.verdict, VERDICTS.verified);
    assert.deepEqual(r.flags, []);
    assert.equal(r.exit, null);
  });

  it('pass-on-base with real tests is a tautology FLAG, never a block', () => {
    const r = evaluate(
      baseObservations({ baseRun: { outcome: 'pass', testsRan: 2, failures: 0 } }),
      'tdd-code'
    );
    assert.equal(r.verdict, VERDICTS.unverified);
    assert.deepEqual(r.flags, ['tautology']);
  });

  it('base worktree setup failure degrades to base-setup-failed', () => {
    const r = evaluate(
      baseObservations({ baseRun: { supported: false, outcome: 'not-run' } }),
      'tdd-code'
    );
    assert.equal(r.verdict, VERDICTS.unverified);
    assert.deepEqual(r.flags, ['base-setup-failed']);
  });

  it('coverage below threshold flags; 0% for a test-requiring kind contradicts (I5)', () => {
    const low = evaluate(
      baseObservations({ coverage: { supported: true, changedLineCoveragePct: 42 } }),
      'tdd-code'
    );
    assert.equal(low.verdict, VERDICTS.unverified);
    assert.deepEqual(low.flags, ['coverage-below-threshold']);

    const zero = evaluate(
      baseObservations({ coverage: { supported: true, changedLineCoveragePct: 0 } }),
      'tdd-code'
    );
    assert.equal(zero.verdict, VERDICTS.contradicted);
    assert.deepEqual(zero.violatedInvariants, ['I5']);
    assert.equal(zero.exit, 'retry');
  });

  it('coverage threshold is configurable', () => {
    const r = evaluate(
      baseObservations({ coverage: { supported: true, changedLineCoveragePct: 42 } }),
      'tdd-code',
      { coverageFlagThreshold: 40 }
    );
    assert.equal(r.verdict, VERDICTS.verified);
  });

  it('mechanical-refactor is fail-on-base exempt but must pass on head', () => {
    const pass = evaluate(
      baseObservations({ baseRun: { outcome: 'pass', testsRan: 5, failures: 0 } }),
      'mechanical-refactor'
    );
    assert.equal(pass.verdict, VERDICTS.verified, 'pass-on-base is fine for refactors');

    const fail = evaluate(
      baseObservations({ headRun: { outcome: 'fail', failures: 1 } }),
      'mechanical-refactor'
    );
    assert.equal(fail.verdict, VERDICTS.contradicted);
    assert.deepEqual(fail.violatedInvariants, ['I4']);
  });

  it('unknown kinds fail closed to the strictest profile', () => {
    assert.equal(profileFor('some-future-kind'), KIND_PROFILES['tdd-code']);
    const r = evaluate(
      baseObservations({ headRun: { outcome: 'pass', testsRan: 0 } }),
      'some-future-kind'
    );
    assert.equal(r.verdict, VERDICTS.contradicted);
    assert.deepEqual(r.violatedInvariants, ['I4']);
  });

  it('every planner kind has a profile', () => {
    for (const kind of TASK_KINDS) {
      assert.ok(KIND_PROFILES[kind], `missing profile for kind: ${kind}`);
    }
  });

  it('null observations degrade to a mechanism flag, never a crash or block', () => {
    const r = evaluate(undefined, 'docs');
    assert.notEqual(r.verdict, VERDICTS.contradicted);
  });
});
