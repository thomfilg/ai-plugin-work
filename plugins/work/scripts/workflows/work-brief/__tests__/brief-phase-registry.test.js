/**
 * Tests for brief-phase-registry.js
 *
 * Run with: node --test scripts/workflows/work-brief/__tests__/brief-phase-registry.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  BRIEF_PHASES,
  BRIEF_PHASE_ORDER,
  BRIEF_PHASE_TRANSITIONS,
  BRIEF_INITIAL_PHASE,
  BRIEF_TERMINAL_PHASE,
  briefNextPhases,
  briefCanTransition,
  isBriefPhase,
} = require('../brief-phase-registry');

describe('brief-phase-registry', () => {
  it('exposes all six phases in canonical order', () => {
    assert.deepEqual(
      [...BRIEF_PHASE_ORDER],
      ['inputs', 'overlap', 'draft', 'validate', 'memorize', 'done']
    );
    for (const p of BRIEF_PHASE_ORDER) {
      assert.equal(BRIEF_PHASES[p], p);
    }
  });

  it('initial and terminal phases match the linear flow', () => {
    assert.equal(BRIEF_INITIAL_PHASE, 'inputs');
    assert.equal(BRIEF_TERMINAL_PHASE, 'done');
  });

  it('linear single-edge transitions: each phase has exactly one successor (except done)', () => {
    assert.deepEqual([...BRIEF_PHASE_TRANSITIONS.inputs], ['overlap']);
    assert.deepEqual([...BRIEF_PHASE_TRANSITIONS.overlap], ['draft']);
    assert.deepEqual([...BRIEF_PHASE_TRANSITIONS.draft], ['validate']);
    assert.deepEqual([...BRIEF_PHASE_TRANSITIONS.validate], ['memorize']);
    assert.deepEqual([...BRIEF_PHASE_TRANSITIONS.memorize], ['done']);
    assert.deepEqual([...BRIEF_PHASE_TRANSITIONS.done], []);
  });

  it('briefNextPhases returns successors and [] for terminal', () => {
    assert.deepEqual([...briefNextPhases('inputs')], ['overlap']);
    assert.deepEqual([...briefNextPhases('done')], []);
    assert.deepEqual([...briefNextPhases('unknown')], []);
  });

  it('briefCanTransition allows only declared edges', () => {
    assert.equal(briefCanTransition('inputs', 'overlap'), true);
    assert.equal(briefCanTransition('overlap', 'draft'), true);
    assert.equal(briefCanTransition('memorize', 'done'), true);
    // Disallowed: skipping, going backwards, leaving terminal.
    assert.equal(briefCanTransition('inputs', 'draft'), false);
    assert.equal(briefCanTransition('draft', 'inputs'), false);
    assert.equal(briefCanTransition('done', 'inputs'), false);
    assert.equal(briefCanTransition('done', 'memorize'), false);
    assert.equal(briefCanTransition('garbage', 'inputs'), false);
  });

  it('isBriefPhase recognizes only the six phases', () => {
    for (const p of BRIEF_PHASE_ORDER) assert.equal(isBriefPhase(p), true);
    assert.equal(isBriefPhase('red'), false);
    assert.equal(isBriefPhase('inputs '), false);
    assert.equal(isBriefPhase(''), false);
    assert.equal(isBriefPhase(undefined), false);
  });

  it('exports are frozen — no accidental mutation', () => {
    assert.throws(() => {
      BRIEF_PHASES.extra = 'oops';
    });
    assert.throws(() => {
      BRIEF_PHASE_ORDER.push('extra');
    });
    assert.throws(() => {
      BRIEF_PHASE_TRANSITIONS.inputs = ['draft'];
    });
  });
});
