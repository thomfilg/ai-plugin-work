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
  ticket: 'ticket',
  bootstrap: 'bootstrap',
  brief: 'brief',
  // GH-215: gate step that blocks spec until unresolved cross-ticket /
  // architectural open questions in brief.md have been answered.
  brief_gate: 'brief_gate',
  spec: 'spec',
  tasks: 'tasks',
  implement: 'implement',
  commit: 'commit',
  // GH-211: per-task review gate that blocks check until review passes.
  task_review: 'task_review',
  check: 'check',
  pr: 'pr',
  ready: 'ready',
  follow_up: 'follow_up',
  ci: 'ci',
  cleanup: 'cleanup',
  reports: 'reports',
  complete: 'complete',
});

// ─── Canonical step ordering ────────────────────────────────────────────────
// Reorder this array to change the workflow execution order.
// Nothing else in the codebase needs to change.
const STEP_ORDER = Object.freeze([
  STEPS.ticket,
  STEPS.bootstrap,
  STEPS.brief,
  STEPS.brief_gate, // GH-215: must sit between brief and spec
  STEPS.spec,
  STEPS.tasks,
  STEPS.implement,
  STEPS.commit,
  STEPS.task_review, // GH-211: must sit between commit and check
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
  const definedStates = new Set(transitions.map((t) => t.source));

  transitions.forEach((t) => {
    statusTransitions[t.source] = t.targets.filter(
      (target) => definedStates.has(target) && target !== t.source
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
//  Forward edges are generated from STEP_ORDER (each step → next step).
//  Retry loops (backward edges) are merged in explicitly.
//  No skip edges — the orchestrator marks steps as SKIP/RUN/DEFER,
//  and the engine transitions through each step sequentially.

// Retry loops: backward edges for failure recovery
const RETRY_EDGES = {
  [STEPS.task_review]: [STEPS.implement], // GH-211: review failed, fix code
  [STEPS.check]: [STEPS.implement], // check failed, fix code
  [STEPS.follow_up]: [STEPS.implement], // follow-up requires code changes
  [STEPS.ci]: [STEPS.implement], // CI failed, fix code
};

// Generate linear forward edges from STEP_ORDER, merge retry edges
const STEP_TRANSITIONS = createStatusTransitions(
  STEP_ORDER.map((step, i) => ({
    source: step,
    targets: [
      ...(i < STEP_ORDER.length - 1 ? [STEP_ORDER[i + 1]] : []),
      ...(RETRY_EDGES[step] || []),
    ],
  }))
);

// GH-106: Add complete -> complete self-transition for retry.
// createStatusTransitions filters self-edges (target !== source), so we add it
// after generation. This allows the terminal step to be retried on partial failure.
if (!STEP_TRANSITIONS[STEPS.complete]) {
  STEP_TRANSITIONS[STEPS.complete] = [];
}
if (!STEP_TRANSITIONS[STEPS.complete].includes(STEPS.complete)) {
  STEP_TRANSITIONS[STEPS.complete].push(STEPS.complete);
}

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
