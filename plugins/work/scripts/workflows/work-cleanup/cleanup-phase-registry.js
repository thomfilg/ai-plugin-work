/**
 * cleanup-phase-registry.js
 *
 * Phases for the WORK orchestrator's `cleanup` step.
 *
 * Phases (linear, 7):
 *   inputs → pr_merged_check → branch_cleanup →
 *   tmux_cleanup → state_archive → memorize → done
 *
 * `pr_merged_check` is a defensive duplicate of ci-step's wait_merge —
 * cleanup must NEVER run on a branch whose PR isn't merged. It blocks
 * (not WAITs) if the PR is OPEN/CLOSED since the workflow shouldn't have
 * reached cleanup at all in those states. It is what bounds the destructive
 * phases: a merged PR is the thing that makes deleting its branch safe.
 *
 * There used to be a `completion_check` phase after it (GH-283), refusing to
 * advance unless `completion.check.md` read `**Status:** COMPLETE`, re-asserted
 * on entry to every destructive phase. It is gone, for the reason the
 * step-level verify dropped it: cleanup runs POST-MERGE, where that evidence
 * cannot change the outcome — it cannot un-merge the PR — and can only strand
 * a shipped ticket. One interrupted completion-check dispatch was enough to
 * leave a merged ticket with an undeletable branch, exitable only by a ~20
 * minute re-run to stamp a bookkeeping artifact, or an operator override.
 * Completion is enforced where it still decides something: leaving `check`,
 * before the PR exists.
 */

'use strict';

const CLEANUP_PHASES = Object.freeze({
  inputs: 'inputs',
  pr_merged_check: 'pr_merged_check',
  branch_cleanup: 'branch_cleanup',
  tmux_cleanup: 'tmux_cleanup',
  state_archive: 'state_archive',
  memorize: 'memorize',
  done: 'done',
});

const CLEANUP_PHASE_ORDER = Object.freeze([
  CLEANUP_PHASES.inputs,
  CLEANUP_PHASES.pr_merged_check,
  CLEANUP_PHASES.branch_cleanup,
  CLEANUP_PHASES.tmux_cleanup,
  CLEANUP_PHASES.state_archive,
  CLEANUP_PHASES.memorize,
  CLEANUP_PHASES.done,
]);

const CLEANUP_PHASE_TRANSITIONS = Object.freeze({
  [CLEANUP_PHASES.inputs]: Object.freeze([CLEANUP_PHASES.pr_merged_check]),
  [CLEANUP_PHASES.pr_merged_check]: Object.freeze([CLEANUP_PHASES.branch_cleanup]),
  [CLEANUP_PHASES.branch_cleanup]: Object.freeze([CLEANUP_PHASES.tmux_cleanup]),
  [CLEANUP_PHASES.tmux_cleanup]: Object.freeze([CLEANUP_PHASES.state_archive]),
  [CLEANUP_PHASES.state_archive]: Object.freeze([CLEANUP_PHASES.memorize]),
  [CLEANUP_PHASES.memorize]: Object.freeze([CLEANUP_PHASES.done]),
  [CLEANUP_PHASES.done]: Object.freeze([]),
});

function cleanupNextPhases(c) {
  return CLEANUP_PHASE_TRANSITIONS[c] || [];
}
function cleanupCanTransition(c, n) {
  return cleanupNextPhases(c).includes(n);
}
function isCleanupPhase(p) {
  return Object.hasOwn(CLEANUP_PHASES, p);
}

const CLEANUP_INITIAL_PHASE = CLEANUP_PHASES.inputs;
const CLEANUP_TERMINAL_PHASE = CLEANUP_PHASES.done;

module.exports = {
  CLEANUP_PHASES,
  CLEANUP_PHASE_ORDER,
  CLEANUP_PHASE_TRANSITIONS,
  CLEANUP_INITIAL_PHASE,
  CLEANUP_TERMINAL_PHASE,
  cleanupNextPhases,
  cleanupCanTransition,
  isCleanupPhase,
};
