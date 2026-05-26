/**
 * brief-phase-registry.js
 *
 * Central registry for brief-phase definitions, ordering, and transitions.
 * Mirrors the shape of tdd-phase-registry.js so brief-phase-state.js and
 * brief-next.js share one source of truth for phase names + edges.
 *
 * Phases (linear): inputs → overlap → draft → validate → memorize → done
 *
 * `done` is terminal — it has no outgoing edges.
 *
 * Usage:
 *   const { BRIEF_PHASES, briefCanTransition } = require('./brief-phase-registry');
 */

'use strict';

const BRIEF_PHASES = Object.freeze({
  inputs: 'inputs',
  overlap: 'overlap',
  draft: 'draft',
  validate: 'validate',
  memorize: 'memorize',
  done: 'done',
});

const BRIEF_PHASE_ORDER = Object.freeze([
  BRIEF_PHASES.inputs,
  BRIEF_PHASES.overlap,
  BRIEF_PHASES.draft,
  BRIEF_PHASES.validate,
  BRIEF_PHASES.memorize,
  BRIEF_PHASES.done,
]);

const BRIEF_PHASE_TRANSITIONS = Object.freeze({
  [BRIEF_PHASES.inputs]: Object.freeze([BRIEF_PHASES.overlap]),
  [BRIEF_PHASES.overlap]: Object.freeze([BRIEF_PHASES.draft]),
  [BRIEF_PHASES.draft]: Object.freeze([BRIEF_PHASES.validate]),
  [BRIEF_PHASES.validate]: Object.freeze([BRIEF_PHASES.memorize]),
  [BRIEF_PHASES.memorize]: Object.freeze([BRIEF_PHASES.done]),
  [BRIEF_PHASES.done]: Object.freeze([]),
});

/**
 * Returns the list of phases reachable from `current` in one step.
 * @param {string} current
 * @returns {readonly string[]}
 */
function briefNextPhases(current) {
  return BRIEF_PHASE_TRANSITIONS[current] || [];
}

/**
 * @param {string} current
 * @param {string} next
 * @returns {boolean}
 */
function briefCanTransition(current, next) {
  return briefNextPhases(current).includes(next);
}

/**
 * @param {string} phase
 * @returns {boolean}
 */
function isBriefPhase(phase) {
  return Object.hasOwn(BRIEF_PHASES, phase);
}

const BRIEF_INITIAL_PHASE = BRIEF_PHASES.inputs;
const BRIEF_TERMINAL_PHASE = BRIEF_PHASES.done;

module.exports = {
  BRIEF_PHASES,
  BRIEF_PHASE_ORDER,
  BRIEF_PHASE_TRANSITIONS,
  BRIEF_INITIAL_PHASE,
  BRIEF_TERMINAL_PHASE,
  briefNextPhases,
  briefCanTransition,
  isBriefPhase,
};
