'use strict';

/**
 * Corpus gate (GH-755, outcome-verification Phase 2; plan §6 Phase 2).
 *
 * Every replay-corpus fixture must produce EXACTLY its labeled verdict when
 * fed through the verdict engine: every historical false-GREEN →
 * CONTRADICTED (with the labeled invariants and typed exit) and every
 * historical wedge → VERIFIED or UNVERIFIED (with the labeled flags), never
 * a dead-end block. A rule change that regresses ANY fixture in either
 * direction fails here and does not ship (fixture-before-fix rule).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { loadCorpus } = require('../../lib/replay-corpus');
const { VERDICTS } = require('../../lib/outcome-verdicts');
const { evaluate } = require('../verdict-engine');

const { fixtures, errors } = loadCorpus();

describe('task-verify corpus gate (GH-755)', () => {
  it('corpus loads cleanly and is non-trivial', () => {
    assert.deepEqual(errors, []);
    assert.ok(fixtures.length >= 18, `expected >= 18 fixtures, got ${fixtures.length}`);
  });

  for (const fixture of fixtures) {
    it(`${fixture.name} → ${fixture.expected.verdict}`, () => {
      const result = evaluate(fixture.observations, fixture.taskKind);

      assert.equal(
        result.verdict,
        fixture.expected.verdict,
        `verdict mismatch (reasons: ${result.reasons.join(' | ') || 'none'}; ` +
          `flags: ${result.flags.join(',') || 'none'})`
      );

      if (fixture.expected.verdict === VERDICTS.contradicted) {
        assert.deepEqual(
          result.violatedInvariants,
          [...fixture.expected.violatedInvariants].sort(),
          `violated-invariant mismatch (reasons: ${result.reasons.join(' | ')})`
        );
        assert.equal(result.exit, fixture.expected.exit, 'typed exit mismatch');
      }

      if (fixture.expected.verdict === VERDICTS.unverified) {
        assert.deepEqual(result.flags, [...fixture.expected.flags].sort(), 'flag mismatch');
      }

      if (fixture.expected.verdict === VERDICTS.verified) {
        assert.deepEqual(result.flags, [], 'VERIFIED must carry no flags');
        assert.deepEqual(result.violatedInvariants, []);
      }
    });
  }

  it('aggregate: no historical wedge maps to a dead-end (exit present on every block)', () => {
    for (const fixture of fixtures) {
      const result = evaluate(fixture.observations, fixture.taskKind);
      if (result.verdict === VERDICTS.contradicted) {
        assert.ok(
          result.exit === 'retry' || result.exit === 'reopen-artifact',
          `${fixture.name}: CONTRADICTED without a recoverable typed exit`
        );
      }
    }
  });
});
