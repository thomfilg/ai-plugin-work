/**
 * qa-phase-registry.js
 *
 * Central registry for qa-feature-tester phase definitions, ordering, and
 * transitions. Mirrors `work-spec/spec-phase-registry.js`.
 *
 * Phases (linear):
 *   inputs → env_setup → smoke → feature → kind_checks →
 *   screenshot → report → memorize → done
 *
 * `done` is terminal.
 */

'use strict';

const QA_PHASES = Object.freeze({
  inputs: 'inputs',
  env_setup: 'env_setup',
  smoke: 'smoke',
  feature: 'feature',
  kind_checks: 'kind_checks',
  screenshot: 'screenshot',
  report: 'report',
  memorize: 'memorize',
  done: 'done',
});

const QA_PHASE_ORDER = Object.freeze([
  QA_PHASES.inputs,
  QA_PHASES.env_setup,
  QA_PHASES.smoke,
  QA_PHASES.feature,
  QA_PHASES.kind_checks,
  QA_PHASES.screenshot,
  QA_PHASES.report,
  QA_PHASES.memorize,
  QA_PHASES.done,
]);

const QA_PHASE_TRANSITIONS = Object.freeze({
  [QA_PHASES.inputs]: Object.freeze([QA_PHASES.env_setup]),
  [QA_PHASES.env_setup]: Object.freeze([QA_PHASES.smoke]),
  [QA_PHASES.smoke]: Object.freeze([QA_PHASES.feature]),
  [QA_PHASES.feature]: Object.freeze([QA_PHASES.kind_checks]),
  [QA_PHASES.kind_checks]: Object.freeze([QA_PHASES.screenshot]),
  [QA_PHASES.screenshot]: Object.freeze([QA_PHASES.report]),
  [QA_PHASES.report]: Object.freeze([QA_PHASES.memorize]),
  [QA_PHASES.memorize]: Object.freeze([QA_PHASES.done]),
  [QA_PHASES.done]: Object.freeze([]),
});

function qaNextPhases(current) {
  return QA_PHASE_TRANSITIONS[current] || [];
}

function qaCanTransition(current, next) {
  return qaNextPhases(current).includes(next);
}

function isQaPhase(phase) {
  return Object.hasOwn(QA_PHASES, phase);
}

const QA_INITIAL_PHASE = QA_PHASES.inputs;
const QA_TERMINAL_PHASE = QA_PHASES.done;

module.exports = {
  QA_PHASES,
  QA_PHASE_ORDER,
  QA_PHASE_TRANSITIONS,
  QA_INITIAL_PHASE,
  QA_TERMINAL_PHASE,
  qaNextPhases,
  qaCanTransition,
  isQaPhase,
};
