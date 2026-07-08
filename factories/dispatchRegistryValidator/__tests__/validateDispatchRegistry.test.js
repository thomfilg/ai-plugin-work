'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { validateDispatchRegistry, handlersForTag } = require('../validateDispatchRegistry');

const noop = () => ({ hit: false });
function handlerMod(name) {
  return { name, detect: noop };
}

describe('validateDispatchRegistry', () => {
  it('accepts a clean registry', () => {
    const r = validateDispatchRegistry({
      baseDispatch: ['a', 'b'],
      dispatch: { p1: ['a'], p2: [] },
      handlers: { a: handlerMod('a'), b: handlerMod('b') },
    });
    assert.equal(r.valid, true, r.errors.join('\n'));
    assert.deepEqual(r.warnings, []);
  });

  it('accepts legacy { detectors: [...] } shape (back-compat)', () => {
    const r = validateDispatchRegistry({
      baseDispatch: { detectors: ['a'] },
      dispatch: { p1: { detectors: ['a'] }, p2: {} },
      handlers: { a: handlerMod('a') },
    });
    assert.equal(r.valid, true, r.errors.join('\n'));
  });

  it('R1: baseDispatch references unknown handler', () => {
    const r = validateDispatchRegistry({
      baseDispatch: ['a', 'nope'],
      dispatch: {},
      handlers: { a: handlerMod('a') },
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /baseDispatch references unknown handler "nope"/.test(e)));
  });

  it('R2: dispatch list references unknown handler (the typo case)', () => {
    const r = validateDispatchRegistry({
      baseDispatch: ['a'],
      dispatch: { implement: ['a', 'commiStall'] }, // missing 't'
      handlers: { a: handlerMod('a'), commitStall: handlerMod('commitStall') },
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /dispatch\["implement"\].*"commiStall"/.test(e)));
  });

  it('R3: catches duplicate handler in a single list', () => {
    const r = validateDispatchRegistry({
      baseDispatch: ['a', 'a'],
      dispatch: {},
      handlers: { a: handlerMod('a') },
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /duplicate handler "a" in baseDispatch/.test(e)));
  });

  it('R4: rejects unknown dispatch key when tagSet is provided', () => {
    const r = validateDispatchRegistry({
      baseDispatch: [],
      dispatch: { implement: [], mystery: [] },
      handlers: {},
      tagSet: new Set(['implement', 'commit', 'check']),
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /"mystery" is not a known tag/.test(e)));
  });

  it('R5: handler key and exported name must agree', () => {
    const r = validateDispatchRegistry({
      baseDispatch: ['phaseStall'],
      dispatch: {},
      handlers: { phaseStall: { name: 'phase-stall', detect: noop } },
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /key and exported name disagree/.test(e)));
  });

  it('R5: missing detect() function', () => {
    const r = validateDispatchRegistry({
      baseDispatch: ['a'],
      dispatch: {},
      handlers: { a: { name: 'a' } },
    });
    assert.equal(r.valid, false);
    assert.ok(
      r.errors.some((e) => /missing required field "detect"|detect is not a function/.test(e))
    );
  });

  it('R5: custom handlerShape requires fields beyond the default', () => {
    const r = validateDispatchRegistry({
      baseDispatch: ['a'],
      dispatch: {},
      handlers: { a: { name: 'a', detect: noop } },
      handlerShape: { requiredFields: ['name', 'detect', 'budget'] },
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /missing required field "budget"/.test(e)));
  });

  it('W1: warns on orphan handler by default', () => {
    const r = validateDispatchRegistry({
      baseDispatch: ['a'],
      dispatch: {},
      handlers: { a: handlerMod('a'), unused: handlerMod('unused') },
    });
    assert.equal(r.valid, true);
    assert.ok(r.warnings.some((w) => /"unused".*never referenced/.test(w)));
  });

  it('allowOrphans: false promotes orphan warning to error', () => {
    const r = validateDispatchRegistry({
      baseDispatch: ['a'],
      dispatch: {},
      handlers: { a: handlerMod('a'), unused: handlerMod('unused') },
      allowOrphans: false,
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /R6:.*"unused".*never referenced/.test(e)));
  });

  it('handlersForTag: override beats baseDispatch (array form)', () => {
    assert.deepEqual(handlersForTag(['a', 'b'], ['c']), ['c']);
    assert.deepEqual(handlersForTag(['a', 'b'], []), []);
    assert.deepEqual(handlersForTag(['a', 'b'], undefined), ['a', 'b']);
  });

  it('handlersForTag: override beats baseDispatch (legacy { detectors } form)', () => {
    const base = { detectors: ['a', 'b'] };
    assert.deepEqual(handlersForTag(base, { detectors: ['c'] }), ['c']);
    assert.deepEqual(handlersForTag(base, {}), ['a', 'b']);
    assert.deepEqual(handlersForTag(base, undefined), ['a', 'b']);
  });

  it('validates a real event-driven dispatch registry (self-test against maestro fixture)', () => {
    // Self-tests may legitimately reference real plugin paths as fixtures;
    // the factory module itself does not import them.
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

    const phaseReg = require(phaseRegPath);
    const baseProfile = phaseReg.phaseFor('__never_a_phase__');
    const baseDispatch = { detectors: baseProfile.detectors };

    const { DETECTORS } = require(conductPath);
    const stepIds = fs.existsSync(stepRegPath) ? Object.values(require(stepRegPath).STEPS) : null;

    const result = validateDispatchRegistry({
      baseDispatch,
      dispatch: phaseReg.PHASES,
      handlers: DETECTORS,
      tagSet: stepIds ? new Set(stepIds) : undefined,
    });
    assert.equal(result.valid, true, result.errors.join('\n'));
  });
});
