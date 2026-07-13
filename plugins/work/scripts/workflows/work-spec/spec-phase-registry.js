/**
 * spec-phase-registry.js
 *
 * Central registry for spec-phase definitions, ordering, and transitions.
 * Mirrors `work-brief/brief-phase-registry.js` so spec-phase-state.js and
 * spec-next.js share one source of truth for phase names + edges.
 *
 * Phases (linear):
 *   inputs → reuse_audit → surface_audit → draft → validate → memorize → kind_checks → done
 *
 * `done` is terminal — no outgoing edges.
 *
 * Usage:
 *   const { SPEC_PHASES, specCanTransition } = require('./spec-phase-registry');
 */

'use strict';

const SPEC_PHASES = Object.freeze({
  inputs: 'inputs',
  reuse_audit: 'reuse_audit',
  surface_audit: 'surface_audit',
  draft: 'draft',
  validate: 'validate',
  memorize: 'memorize',
  kind_checks: 'kind_checks',
  done: 'done',
});

const SPEC_PHASE_ORDER = Object.freeze([
  SPEC_PHASES.inputs,
  SPEC_PHASES.reuse_audit,
  SPEC_PHASES.surface_audit,
  SPEC_PHASES.draft,
  SPEC_PHASES.validate,
  SPEC_PHASES.memorize,
  SPEC_PHASES.kind_checks,
  SPEC_PHASES.done,
]);

const SPEC_PHASE_TRANSITIONS = Object.freeze({
  [SPEC_PHASES.inputs]: Object.freeze([SPEC_PHASES.reuse_audit]),
  [SPEC_PHASES.reuse_audit]: Object.freeze([SPEC_PHASES.surface_audit]),
  [SPEC_PHASES.surface_audit]: Object.freeze([SPEC_PHASES.draft]),
  [SPEC_PHASES.draft]: Object.freeze([SPEC_PHASES.validate]),
  [SPEC_PHASES.validate]: Object.freeze([SPEC_PHASES.memorize]),
  [SPEC_PHASES.memorize]: Object.freeze([SPEC_PHASES.kind_checks]),
  [SPEC_PHASES.kind_checks]: Object.freeze([SPEC_PHASES.done]),
  [SPEC_PHASES.done]: Object.freeze([]),
});

function specNextPhases(current) {
  return SPEC_PHASE_TRANSITIONS[current] || [];
}

function specCanTransition(current, next) {
  return specNextPhases(current).includes(next);
}

function isSpecPhase(phase) {
  return Object.hasOwn(SPEC_PHASES, phase);
}

const SPEC_INITIAL_PHASE = SPEC_PHASES.inputs;
const SPEC_TERMINAL_PHASE = SPEC_PHASES.done;

module.exports = {
  SPEC_PHASES,
  SPEC_PHASE_ORDER,
  SPEC_PHASE_TRANSITIONS,
  SPEC_INITIAL_PHASE,
  SPEC_TERMINAL_PHASE,
  specNextPhases,
  specCanTransition,
  isSpecPhase,
};
