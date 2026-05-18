/**
 * Tests for the brief phase dispatcher (lib/phase-registry.js).
 *
 * Run: node --test ./scripts/workflows/work-brief/__tests__/phase-registry.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { BRIEF_PHASES, BRIEF_PHASE_ORDER } = require('../brief-phase-registry');
const { getPhase, hasPhase } = require('../lib/phase-registry');

describe('lib/phase-registry — modular brief phase dispatcher', () => {
  it('registers every phase from BRIEF_PHASES', () => {
    for (const name of BRIEF_PHASE_ORDER) {
      assert.equal(hasPhase(name), true, `phase "${name}" must be registered`);
    }
  });

  it('every handler exposes validate() and instructions()', () => {
    for (const name of BRIEF_PHASE_ORDER) {
      const h = getPhase(name);
      assert.equal(typeof h.validate, 'function', `${name}.validate must be a function`);
      assert.equal(typeof h.instructions, 'function', `${name}.instructions must be a function`);
    }
  });

  it('handler.next matches the registry transition graph', () => {
    const expected = {
      inputs: BRIEF_PHASES.overlap,
      overlap: BRIEF_PHASES.draft,
      draft: BRIEF_PHASES.validate,
      validate: BRIEF_PHASES.memorize,
      memorize: BRIEF_PHASES.done,
      done: null,
    };
    for (const [name, next] of Object.entries(expected)) {
      assert.equal(getPhase(name).next, next, `${name}.next must equal ${next}`);
    }
  });

  it('getPhase throws for unknown phases', () => {
    assert.throws(() => getPhase('not-a-phase'));
    assert.equal(hasPhase('not-a-phase'), false);
  });

  it('terminal phase (done) returns ok:false with no errors — no advance possible', () => {
    const v = getPhase(BRIEF_PHASES.done).validate({});
    assert.equal(v.ok, false);
    assert.deepEqual(v.errors || [], []);
  });

  it('memorize: no memory plugin → auto-advance (ok:true with summary)', () => {
    const v = getPhase(BRIEF_PHASES.memorize).validate({
      memory: null,
      tasksDir: '/tmp/nonexistent',
    });
    assert.equal(v.ok, true);
    assert.match(v.summary, /no-memory-plugin/);
  });

  it('inputs handler returns useful errors when manifest missing', () => {
    const v = getPhase(BRIEF_PHASES.inputs).validate({
      tasksDir: '/tmp/nonexistent',
      manifest: null,
      linkedIds: [],
      memory: null,
    });
    assert.equal(v.ok, false);
    assert.ok(Array.isArray(v.errors));
    assert.match(v.errors[0], /related-tickets\.json missing/);
  });

  it('inputs handler returns ok:true when manifest exists and no linked tickets', () => {
    const v = getPhase(BRIEF_PHASES.inputs).validate({
      tasksDir: '/tmp/nonexistent',
      manifest: { parent: null, siblings: [] },
      linkedIds: [],
      memory: { name: 'cortex' },
    });
    assert.equal(v.ok, true);
    assert.match(v.summary, /linked=0/);
    assert.match(v.summary, /memory=cortex/);
  });

  it('instructions() returns a non-empty markdown string for every phase', () => {
    const ctx = {
      ticket: 'TEST-1',
      tasksDir: '/tmp/x',
      linkedIds: [],
      manifest: null,
      memory: null,
    };
    for (const name of BRIEF_PHASE_ORDER) {
      const md = getPhase(name).instructions(ctx);
      assert.equal(typeof md, 'string');
      assert.ok(md.length > 20, `${name} instructions must be non-trivial markdown`);
    }
  });
});
