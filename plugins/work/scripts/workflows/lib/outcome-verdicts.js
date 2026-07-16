'use strict';

/**
 * outcome-verdicts.js — shared vocabulary for the outcome-verification work
 * (GH-750 epic; docs/implement-outcome-verification-plan.md §5.2).
 *
 * One tiny module so the replay corpus (GH-751), the task verifier (GH-755),
 * and the flip wiring (GH-756) can never drift on the verdict/exit/invariant
 * names. Data only — no behavior.
 */

/**
 * The three verdicts a task-boundary verification can produce.
 * - VERIFIED      → advance.
 * - UNVERIFIED    → advance WITH flags (couldn't check; absence of evidence
 *                   never blocks).
 * - CONTRADICTED  → block with a typed exit (positive evidence of a problem).
 */
const VERDICTS = Object.freeze({
  verified: 'VERIFIED',
  unverified: 'UNVERIFIED',
  contradicted: 'CONTRADICTED',
});

/**
 * Typed exits — every CONTRADICTED verdict must name exactly one, so liveness
 * is a provable invariant (a block that cannot name its exit may not block).
 */
const EXITS = Object.freeze({
  retry: 'retry',
  reopenArtifact: 'reopen-artifact',
  escalate: 'escalate',
});

/** The five mechanical invariants observed from a task's commits. */
const INVARIANTS = Object.freeze({
  diffInScope: 'I1',
  deliverablesExist: 'I2',
  failOnBase: 'I3',
  passOnHead: 'I4',
  diffCoverage: 'I5',
});

/**
 * Flag kinds attached to UNVERIFIED advances (and to soft findings on
 * otherwise-advancing verdicts). Consumed by task_review and the check step.
 */
const FLAG_KINDS = Object.freeze({
  noStructuredReporter: 'no-structured-reporter',
  baseSetupFailed: 'base-setup-failed',
  coverageUnavailable: 'coverage-unavailable',
  coverageBelowThreshold: 'coverage-below-threshold',
  tautology: 'tautology',
  runnerUnknown: 'runner-unknown',
  scopeResolutionFailed: 'scope-resolution-failed',
});

/**
 * Task kinds the verifier profiles over — mirrors the planner's kind
 * vocabulary (split-in-tasks/lib/task-types.js) so fixtures and profiles
 * speak the same language.
 */
const TASK_KINDS = Object.freeze([
  'tdd-code',
  'tests-only',
  'mechanical-refactor',
  'docs',
  'config',
  'ci',
  'file-move',
  'checkpoint',
  'verified-by',
  'wiring-citation',
]);

const VERDICT_VALUES = Object.freeze(Object.values(VERDICTS));
const EXIT_VALUES = Object.freeze(Object.values(EXITS));
const INVARIANT_VALUES = Object.freeze(Object.values(INVARIANTS));
const FLAG_KIND_VALUES = Object.freeze(Object.values(FLAG_KINDS));

module.exports = {
  VERDICTS,
  EXITS,
  INVARIANTS,
  FLAG_KINDS,
  TASK_KINDS,
  VERDICT_VALUES,
  EXIT_VALUES,
  INVARIANT_VALUES,
  FLAG_KIND_VALUES,
};
