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
  quality:          'quality',
  commit:           'commit',
  check:            'check',
  test_enhancement: 'test_enhancement',
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
  STEPS.quality,
  STEPS.commit,
  STEPS.check,
  STEPS.test_enhancement,
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
//  Happy path:  ticket→bootstrap→brief→spec→implement→quality→commit→check→test_enhancement→pr→ready→follow_up→ci→cleanup→reports→complete
//
//  Retry loops (backward edges):
//    quality         → implement       (quality failed, re-implement)
//    commit          → quality         (re-verify quality after commit)
//    check           → implement       (check failed, fix code)
//    check           → quality         (check needs quality re-run)
//    test_enhancement→ commit          (enhanced tests need committing)
//    test_enhancement→ quality         (new tests need quality check)
//    test_enhancement→ implement       (tests reveal implementation flaw)
//    ci              → implement       (CI failed, fix code)
//    ci              → test_enhancement(coverage failed)
//
//  Skip edges (forward jumps):
//    bootstrap       → implement       (brief/spec disabled or done)
//    bootstrap       → quality         (resume: code exists)
//    bootstrap       → commit          (resume: code + quality done)
//    bootstrap       → check           (resume: committed, need check)
//    brief           → implement       (spec disabled, skip to implement)
//    check           → test_enhancement(no cleanup needed)
//    pr              → ci              (PR already ready, skip ready)

const STEP_TRANSITIONS = createStatusTransitions([
  { source: STEPS.ticket,            targets: [STEPS.bootstrap] },
  { source: STEPS.bootstrap,         targets: [STEPS.brief, STEPS.spec, STEPS.implement, STEPS.quality, STEPS.commit, STEPS.check] },
  { source: STEPS.brief,             targets: [STEPS.spec, STEPS.implement] },
  { source: STEPS.spec,              targets: [STEPS.implement] },
  { source: STEPS.implement,         targets: [STEPS.quality] },
  { source: STEPS.quality,           targets: [STEPS.commit, STEPS.implement] },
  { source: STEPS.commit,            targets: [STEPS.check, STEPS.quality] },
  { source: STEPS.check,             targets: [STEPS.test_enhancement, STEPS.implement, STEPS.quality] },
  { source: STEPS.test_enhancement,  targets: [STEPS.pr, STEPS.commit, STEPS.quality, STEPS.implement] },
  { source: STEPS.pr,                targets: [STEPS.ready, STEPS.ci] },
  { source: STEPS.ready,             targets: [STEPS.follow_up, STEPS.ci] }, // ready→ci is a skip edge when follow_up is skipped (no PR/draft)
  { source: STEPS.follow_up,         targets: [STEPS.ci, STEPS.cleanup, STEPS.implement, STEPS.test_enhancement] }, // enforcement: commandMap maps Skill(follow-up-pr) → follow_up
  { source: STEPS.ci,                targets: [STEPS.cleanup, STEPS.implement, STEPS.test_enhancement] },          // enforcement: description-based pattern match
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
