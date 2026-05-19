/**
 * pr-review-phase-registry.js
 *
 * Central registry for pr-reviewer phase definitions. Mirrors
 * work-spec/spec-phase-registry.js.
 *
 * Phases (linear):
 *   inputs → pr_context → diff_audit → standards_audit →
 *   kind_checks → review_post → memorize → done
 *
 * `done` is terminal.
 */

'use strict';

const PR_REVIEW_PHASES = Object.freeze({
  inputs: 'inputs',
  pr_context: 'pr_context',
  diff_audit: 'diff_audit',
  standards_audit: 'standards_audit',
  kind_checks: 'kind_checks',
  review_post: 'review_post',
  memorize: 'memorize',
  done: 'done',
});

const PR_REVIEW_PHASE_ORDER = Object.freeze([
  PR_REVIEW_PHASES.inputs,
  PR_REVIEW_PHASES.pr_context,
  PR_REVIEW_PHASES.diff_audit,
  PR_REVIEW_PHASES.standards_audit,
  PR_REVIEW_PHASES.kind_checks,
  PR_REVIEW_PHASES.review_post,
  PR_REVIEW_PHASES.memorize,
  PR_REVIEW_PHASES.done,
]);

const PR_REVIEW_PHASE_TRANSITIONS = Object.freeze({
  [PR_REVIEW_PHASES.inputs]: Object.freeze([PR_REVIEW_PHASES.pr_context]),
  [PR_REVIEW_PHASES.pr_context]: Object.freeze([PR_REVIEW_PHASES.diff_audit]),
  [PR_REVIEW_PHASES.diff_audit]: Object.freeze([PR_REVIEW_PHASES.standards_audit]),
  [PR_REVIEW_PHASES.standards_audit]: Object.freeze([PR_REVIEW_PHASES.kind_checks]),
  [PR_REVIEW_PHASES.kind_checks]: Object.freeze([PR_REVIEW_PHASES.review_post]),
  [PR_REVIEW_PHASES.review_post]: Object.freeze([PR_REVIEW_PHASES.memorize]),
  [PR_REVIEW_PHASES.memorize]: Object.freeze([PR_REVIEW_PHASES.done]),
  [PR_REVIEW_PHASES.done]: Object.freeze([]),
});

function prReviewNextPhases(current) {
  return PR_REVIEW_PHASE_TRANSITIONS[current] || [];
}

function prReviewCanTransition(current, next) {
  return prReviewNextPhases(current).includes(next);
}

function isPrReviewPhase(phase) {
  return Object.hasOwn(PR_REVIEW_PHASES, phase);
}

const PR_REVIEW_INITIAL_PHASE = PR_REVIEW_PHASES.inputs;
const PR_REVIEW_TERMINAL_PHASE = PR_REVIEW_PHASES.done;

module.exports = {
  PR_REVIEW_PHASES,
  PR_REVIEW_PHASE_ORDER,
  PR_REVIEW_PHASE_TRANSITIONS,
  PR_REVIEW_INITIAL_PHASE,
  PR_REVIEW_TERMINAL_PHASE,
  prReviewNextPhases,
  prReviewCanTransition,
  isPrReviewPhase,
};
