/**
 * task-review-phase-registry.js
 *
 * Central registry for task-review phase definitions. Mirrors
 * pr-review-phase-registry.js.
 *
 * Phases (linear):
 *   inputs → diff_audit → reuse_check → kind_checks →
 *   coverage → report → memorize → done
 *
 * `done` is terminal.
 */

'use strict';

const TASK_REVIEW_PHASES = Object.freeze({
  inputs: 'inputs',
  diff_audit: 'diff_audit',
  reuse_check: 'reuse_check',
  kind_checks: 'kind_checks',
  coverage: 'coverage',
  report: 'report',
  memorize: 'memorize',
  done: 'done',
});

const TASK_REVIEW_PHASE_ORDER = Object.freeze([
  TASK_REVIEW_PHASES.inputs,
  TASK_REVIEW_PHASES.diff_audit,
  TASK_REVIEW_PHASES.reuse_check,
  TASK_REVIEW_PHASES.kind_checks,
  TASK_REVIEW_PHASES.coverage,
  TASK_REVIEW_PHASES.report,
  TASK_REVIEW_PHASES.memorize,
  TASK_REVIEW_PHASES.done,
]);

const TASK_REVIEW_PHASE_TRANSITIONS = Object.freeze({
  [TASK_REVIEW_PHASES.inputs]: Object.freeze([TASK_REVIEW_PHASES.diff_audit]),
  [TASK_REVIEW_PHASES.diff_audit]: Object.freeze([TASK_REVIEW_PHASES.reuse_check]),
  [TASK_REVIEW_PHASES.reuse_check]: Object.freeze([TASK_REVIEW_PHASES.kind_checks]),
  [TASK_REVIEW_PHASES.kind_checks]: Object.freeze([TASK_REVIEW_PHASES.coverage]),
  [TASK_REVIEW_PHASES.coverage]: Object.freeze([TASK_REVIEW_PHASES.report]),
  [TASK_REVIEW_PHASES.report]: Object.freeze([TASK_REVIEW_PHASES.memorize]),
  [TASK_REVIEW_PHASES.memorize]: Object.freeze([TASK_REVIEW_PHASES.done]),
  [TASK_REVIEW_PHASES.done]: Object.freeze([]),
});

function taskReviewNextPhases(current) {
  return TASK_REVIEW_PHASE_TRANSITIONS[current] || [];
}

function taskReviewCanTransition(current, next) {
  return taskReviewNextPhases(current).includes(next);
}

function isTaskReviewPhase(phase) {
  return Object.hasOwn(TASK_REVIEW_PHASES, phase);
}

const TASK_REVIEW_INITIAL_PHASE = TASK_REVIEW_PHASES.inputs;
const TASK_REVIEW_TERMINAL_PHASE = TASK_REVIEW_PHASES.done;

module.exports = {
  TASK_REVIEW_PHASES,
  TASK_REVIEW_PHASE_ORDER,
  TASK_REVIEW_PHASE_TRANSITIONS,
  TASK_REVIEW_INITIAL_PHASE,
  TASK_REVIEW_TERMINAL_PHASE,
  taskReviewNextPhases,
  taskReviewCanTransition,
  isTaskReviewPhase,
};
