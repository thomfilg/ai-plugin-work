'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { validatePhaseRegistry, detectorsForPhase } = require('../validatePhaseRegistry');

const noop = () => ({ hit: false });
function detectorMod(name) {
  return { name, detect: noop };
}

describe('validatePhaseRegistry', () => {
  it('accepts a clean registry', () => {
    const r = validatePhaseRegistry({
      BASE: { detectors: ['a', 'b'] },
      PHASES: { p1: { detectors: ['a'] }, p2: {} },
      detectors: { a: detectorMod('a'), b: detectorMod('b') },
    });
    assert.equal(r.valid, true, r.errors.join('\n'));
    assert.deepEqual(r.warnings, []);
  });

  it('R1: BASE references unknown detector', () => {
    const r = validatePhaseRegistry({
      BASE: { detectors: ['a', 'nope'] },
      PHASES: {},
      detectors: { a: detectorMod('a') },
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /BASE.detectors references unknown detector "nope"/.test(e)));
  });

  it('R2: PHASES references unknown detector (the typo case)', () => {
    const r = validatePhaseRegistry({
      BASE: { detectors: ['a'] },
      PHASES: { implement: { detectors: ['a', 'commiStall'] } }, // missing 't'
      detectors: { a: detectorMod('a'), commitStall: detectorMod('commitStall') },
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /PHASES\["implement"\].*"commiStall"/.test(e)));
  });

  it('R3: catches duplicate detector in a single list', () => {
    const r = validatePhaseRegistry({
      BASE: { detectors: ['a', 'a'] },
      PHASES: {},
      detectors: { a: detectorMod('a') },
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /duplicate detector "a" in BASE/.test(e)));
  });

  it('R4: rejects unknown phase key when stepIds is provided', () => {
    const r = validatePhaseRegistry({
      BASE: { detectors: [] },
      PHASES: { implement: {}, mystery: {} },
      detectors: {},
      stepIds: ['implement', 'commit', 'check'],
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /"mystery" is not a known \/work step id/.test(e)));
  });

  it('R5: detector key and exported name must agree', () => {
    const r = validatePhaseRegistry({
      BASE: { detectors: ['phaseStall'] },
      PHASES: {},
      detectors: { phaseStall: { name: 'phase-stall', detect: noop } },
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /key and exported name disagree/.test(e)));
  });

  it('R5: missing detect() function', () => {
    const r = validatePhaseRegistry({
      BASE: { detectors: ['a'] },
      PHASES: {},
      detectors: { a: { name: 'a' } },
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /has no detect\(\)/.test(e)));
  });

  it('W1: warns on orphan detector', () => {
    const r = validatePhaseRegistry({
      BASE: { detectors: ['a'] },
      PHASES: {},
      detectors: { a: detectorMod('a'), unused: detectorMod('unused') },
    });
    assert.equal(r.valid, true);
    assert.ok(r.warnings.some((w) => /"unused".*never referenced/.test(w)));
  });

  it('detectorsForPhase: phase override beats BASE', () => {
    const BASE = { detectors: ['a', 'b'] };
    assert.deepEqual(detectorsForPhase(BASE, { detectors: ['c'] }), ['c']);
    assert.deepEqual(detectorsForPhase(BASE, {}), ['a', 'b']);
    assert.deepEqual(detectorsForPhase(BASE, undefined), ['a', 'b']);
  });

  it('validates the real maestro phase registry (self-test)', () => {
    const phaseRegPath = path.resolve(
      __dirname,
      '../../../plugins/maestro/scripts/lib/maestro-conduct/phase-registry.js'
    );
    const conductPath = path.resolve(
      __dirname,
      '../../../plugins/maestro/scripts/maestro-conduct.js'
    );
    const stepRegPath = path.resolve(
      __dirname,
      '../../../plugins/work/scripts/workflows/work/step-registry.js'
    );
    if (!fs.existsSync(phaseRegPath) || !fs.existsSync(conductPath)) return;

    // We need the bare BASE + PHASES, and they're not exported from
    // phase-registry.js individually — but `PHASES` is. We reconstruct the
    // BASE-equivalent surface by reading phaseFor('unknown-phase') which
    // returns BASE merged onto UNKNOWN. The detectors[] there is BASE.detectors.
    const phaseReg = require(phaseRegPath);
    const baseProfile = phaseReg.phaseFor('__never_a_phase__');
    const BASE = { detectors: baseProfile.detectors };

    const { DETECTORS } = require(conductPath);
    const stepIds = fs.existsSync(stepRegPath) ? Object.values(require(stepRegPath).STEPS) : null;

    const result = validatePhaseRegistry({
      BASE,
      PHASES: phaseReg.PHASES,
      detectors: DETECTORS,
      stepIds,
    });
    assert.equal(result.valid, true, result.errors.join('\n'));
  });
});
