/**
 * step-registry.js
 *
 * Central registry for /work workflow step identifiers.
 * Step IDs are decoupled from ordering — reorder STEP_ORDER or edit
 * STEP_TRANSITIONS without renaming any step across the codebase.
 *
 * Usage:
 *   const { STEPS, STEP_ORDER, STEP_TRANSITIONS, ALL_STEPS } = require('./step-registry');
 *   if (step === STEPS.implement) { ... }
 */

// ─── Step IDs (order-independent) ───────────────────────────────────────────
const STEPS = Object.freeze({
  ticket:           'ticket',
  bootstrap:        'bootstrap',
  brief:            'brief',
  spec:             'spec',
  implement:        'implement',
  commit:           'commit',
  check:            'check',
  pr:               'pr',
  ready:            'ready',
  follow_up:        'follow_up',
  ci:               'ci',
  cleanup:          'cleanup',
  reports:          'reports',
  complete:         'complete',
});

// ─── Canonical step ordering ────────────────────────────────────────────────
// Reorder this array to change the workflow execution order.
// Nothing else in the codebase needs to change.
const STEP_ORDER = Object.freeze([
  STEPS.ticket,
  STEPS.bootstrap,
  STEPS.brief,
  STEPS.spec,
  STEPS.implement,
  STEPS.commit,
  STEPS.check,
  STEPS.pr,
  STEPS.ready,
  STEPS.follow_up,
  STEPS.ci,
  STEPS.cleanup,
  STEPS.reports,
  STEPS.complete,
]);

// ─── State Machine Helpers ──────────────────────────────────────────────────

/**
 * @param {Array<{source: string, targets: string[]}>} transitions
 * @returns {{[key: string]: string[]}}
 */
function createStatusTransitions(transitions) {
  const statusTransitions = {};
  const definedStates = new Set(transitions.map(t => t.source));

  transitions.forEach(t => {
    statusTransitions[t.source] = t.targets.filter(
      target => definedStates.has(target) && target !== t.source,
    );
  });

  return statusTransitions;
}

/**
 * @param {{[key: string]: string[]}} statusTransitions
 * @returns {(current: string, next: string) => boolean}
 */
function canTransition(statusTransitions) {
  return (currentStatus, newStatus) => {
    const validNext = statusTransitions[currentStatus] || [];
    return validNext.includes(newStatus);
  };
}

// ─── Step Transition Graph ──────────────────────────────────────────────────
//
//  Happy path:  ticket→bootstrap→brief→spec→implement→commit→check→pr→ready→follow_up→ci→cleanup→reports→complete
//
//  Retry loops (backward edges):
//    check           → implement       (check failed, fix code)
//    follow_up       → implement       (follow-up requires code changes)
//    ci              → implement       (CI failed, fix code)
//
//  No skip edges — the orchestrator marks steps as SKIP/RUN/DEFER,
//  and the engine transitions through each step sequentially.

const STEP_TRANSITIONS = createStatusTransitions([
  { source: STEPS.ticket,            targets: [STEPS.bootstrap] },
  { source: STEPS.bootstrap,         targets: [STEPS.brief] },
  { source: STEPS.brief,             targets: [STEPS.spec] },
  { source: STEPS.spec,              targets: [STEPS.implement] },
  { source: STEPS.implement,         targets: [STEPS.commit] },
  { source: STEPS.commit,            targets: [STEPS.check] },
  { source: STEPS.check,             targets: [STEPS.pr, STEPS.implement] },
  { source: STEPS.pr,                targets: [STEPS.ready] },
  { source: STEPS.ready,             targets: [STEPS.follow_up] },
  { source: STEPS.follow_up,         targets: [STEPS.ci, STEPS.implement] },
  { source: STEPS.ci,                targets: [STEPS.cleanup, STEPS.implement] },
  { source: STEPS.cleanup,           targets: [STEPS.reports] },
  { source: STEPS.reports,           targets: [STEPS.complete] },
  { source: STEPS.complete,          targets: [] },
]);

// ALL_STEPS derived from STEP_ORDER to guarantee ordering consistency
const ALL_STEPS = [...STEP_ORDER];

const workflowCanTransition = canTransition(STEP_TRANSITIONS);

module.exports = {
  STEPS,
  STEP_ORDER,
  STEP_TRANSITIONS,
  ALL_STEPS,
  createStatusTransitions,
  canTransition,
  workflowCanTransition,
};
