/**
 * W4 (implement-phase fix design) — citation-kind GREEN evidence must
 * validate.
 *
 * A green-only cycle whose green.kind ∈ {verified-by, wiring-citation}
 * (written by tdd-phase-state/strategy.js recordCitationEvidence:
 * { kind, peer, peerSha, scopeOverlap, recordedAt }) IS a complete cycle —
 * citation kinds have no runnable command, so no RED can ever exist.
 * validateTddEvidence previously rejected these shapes, producing a
 * permanent retry loop at the implement gate and a permanent block in
 * enforce-tdd-on-stop.js.
 *
 * Integrity rule: peerSha must be present (non-empty string).
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { validateTddEvidence } = require(path.join(__dirname, '..', 'tdd-enforcement'));

function citationGreen(overrides) {
  return {
    kind: 'verified-by',
    peer: 2,
    peerSha: 'abc123def456',
    scopeOverlap: true,
    recordedAt: '2026-07-05T00:00:00.000Z',
    ...overrides,
  };
}

describe('validateTddEvidence — citation-kind GREEN evidence (W4)', () => {
  it('accepts a green-only cycle with kind=verified-by and peerSha', () => {
    const result = validateTddEvidence({
      currentPhase: 'green',
      currentCycle: 1,
      cycles: [{ cycle: 1, green: citationGreen() }],
    });
    assert.deepEqual(result, { valid: true, reason: '' });
  });

  it('accepts a green-only cycle with kind=wiring-citation and peerSha', () => {
    const result = validateTddEvidence({
      cycles: [{ cycle: 1, green: citationGreen({ kind: 'wiring-citation' }) }],
    });
    assert.deepEqual(result, { valid: true, reason: '' });
  });

  it('rejects citation evidence with peerSha missing', () => {
    const green = citationGreen();
    delete green.peerSha;
    const result = validateTddEvidence({ cycles: [{ cycle: 1, green }] });
    assert.equal(result.valid, false);
    assert.match(result.reason, /peerSha/);
  });

  it('rejects citation evidence with an empty/whitespace peerSha', () => {
    const result = validateTddEvidence({
      cycles: [{ cycle: 1, green: citationGreen({ peerSha: '   ' }) }],
    });
    assert.equal(result.valid, false);
    assert.match(result.reason, /peerSha/);
  });

  it('rejects citation evidence with a non-string peerSha', () => {
    const result = validateTddEvidence({
      cycles: [{ cycle: 1, green: citationGreen({ peerSha: 42 }) }],
    });
    assert.equal(result.valid, false);
    assert.match(result.reason, /peerSha/);
  });

  it('still rejects a green-only cycle whose kind is NOT a citation kind', () => {
    const result = validateTddEvidence({
      cycles: [{ cycle: 1, green: { testCommand: 'pnpm test', testExitCode: 0 } }],
    });
    assert.equal(result.valid, false);
    assert.match(result.reason, /No cycle has both RED and GREEN/);
  });

  it('does not let a fabricated kind self-certify (kind must be in the closed set)', () => {
    const result = validateTddEvidence({
      cycles: [{ cycle: 1, green: citationGreen({ kind: 'self-verified' }) }],
    });
    assert.equal(result.valid, false);
    assert.match(result.reason, /No cycle has both RED and GREEN/);
  });

  it('still accepts a normal partial RED+GREEN cycle (regression)', () => {
    const result = validateTddEvidence({
      cycles: [
        {
          cycle: 1,
          red: { testCommand: 'pnpm test', testExitCode: 1 },
          green: { testCommand: 'pnpm test', testExitCode: 0 },
        },
      ],
    });
    assert.deepEqual(result, { valid: true, reason: '' });
  });

  it('still rejects red-only evidence (regression)', () => {
    const result = validateTddEvidence({
      cycles: [{ cycle: 1, red: { testCommand: 'pnpm test', testExitCode: 1 } }],
    });
    assert.equal(result.valid, false);
  });

  it('accepts citation green in a later cycle (not only cycles[0])', () => {
    const result = validateTddEvidence({
      cycles: [{ cycle: 1 }, { cycle: 2, green: citationGreen() }],
    });
    assert.deepEqual(result, { valid: true, reason: '' });
  });
});
