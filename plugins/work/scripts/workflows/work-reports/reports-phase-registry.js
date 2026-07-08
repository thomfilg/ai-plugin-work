/**
 * reports-phase-registry.js
 *
 * Central registry for reports phase definitions. Mirrors
 * pr-review-phase-registry.js but simpler (no per-kind branch).
 *
 * Phases (linear):
 *   inputs → collect_artifacts → summarize → emit → memorize → done
 */

'use strict';

const REPORTS_PHASES = Object.freeze({
  inputs: 'inputs',
  collect_artifacts: 'collect_artifacts',
  summarize: 'summarize',
  emit: 'emit',
  memorize: 'memorize',
  done: 'done',
});

const REPORTS_PHASE_ORDER = Object.freeze([
  REPORTS_PHASES.inputs,
  REPORTS_PHASES.collect_artifacts,
  REPORTS_PHASES.summarize,
  REPORTS_PHASES.emit,
  REPORTS_PHASES.memorize,
  REPORTS_PHASES.done,
]);

const REPORTS_PHASE_TRANSITIONS = Object.freeze({
  [REPORTS_PHASES.inputs]: Object.freeze([REPORTS_PHASES.collect_artifacts]),
  [REPORTS_PHASES.collect_artifacts]: Object.freeze([REPORTS_PHASES.summarize]),
  [REPORTS_PHASES.summarize]: Object.freeze([REPORTS_PHASES.emit]),
  [REPORTS_PHASES.emit]: Object.freeze([REPORTS_PHASES.memorize]),
  [REPORTS_PHASES.memorize]: Object.freeze([REPORTS_PHASES.done]),
  [REPORTS_PHASES.done]: Object.freeze([]),
});

function reportsNextPhases(current) {
  return REPORTS_PHASE_TRANSITIONS[current] || [];
}

function reportsCanTransition(current, next) {
  return reportsNextPhases(current).includes(next);
}

function isReportsPhase(phase) {
  return Object.hasOwn(REPORTS_PHASES, phase);
}

const REPORTS_INITIAL_PHASE = REPORTS_PHASES.inputs;
const REPORTS_TERMINAL_PHASE = REPORTS_PHASES.done;

module.exports = {
  REPORTS_PHASES,
  REPORTS_PHASE_ORDER,
  REPORTS_PHASE_TRANSITIONS,
  REPORTS_INITIAL_PHASE,
  REPORTS_TERMINAL_PHASE,
  reportsNextPhases,
  reportsCanTransition,
  isReportsPhase,
};
