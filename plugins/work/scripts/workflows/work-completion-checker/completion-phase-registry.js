/**
 * completion-phase-registry.js
 *
 * Central registry for completion-checker phase definitions, ordering, and
 * transitions. Mirrors `work-spec/spec-phase-registry.js` so
 * completion-phase-state.js and completion-next.js share one source of
 * truth for phase names + edges.
 *
 * Phases (linear):
 *   inputs → requirements_extract → diff_scope → coverage_check →
 *   reuse_audit_enforcement → suggested_scope_enforcement →
 *   test_pass_crossref → kind_checks → report → memorize → done
 *
 * `done` is terminal.
 */

'use strict';

const COMPLETION_PHASES = Object.freeze({
  inputs: 'inputs',
  requirements_extract: 'requirements_extract',
  diff_scope: 'diff_scope',
  coverage_check: 'coverage_check',
  // ── GH-282: enforcement phases inserted between coverage_check and
  // kind_checks. Keep these three grouped together so future maintainers
  // see the wiring as a single block.
  reuse_audit_enforcement: 'reuse_audit_enforcement',
  suggested_scope_enforcement: 'suggested_scope_enforcement',
  test_pass_crossref: 'test_pass_crossref',
  // ── end GH-282 insertion block
  kind_checks: 'kind_checks',
  report: 'report',
  memorize: 'memorize',
  done: 'done',
});

const COMPLETION_PHASE_ORDER = Object.freeze([
  COMPLETION_PHASES.inputs,
  COMPLETION_PHASES.requirements_extract,
  COMPLETION_PHASES.diff_scope,
  COMPLETION_PHASES.coverage_check,
  COMPLETION_PHASES.reuse_audit_enforcement,
  COMPLETION_PHASES.suggested_scope_enforcement,
  COMPLETION_PHASES.test_pass_crossref,
  COMPLETION_PHASES.kind_checks,
  COMPLETION_PHASES.report,
  COMPLETION_PHASES.memorize,
  COMPLETION_PHASES.done,
]);

const COMPLETION_PHASE_TRANSITIONS = Object.freeze({
  [COMPLETION_PHASES.inputs]: Object.freeze([COMPLETION_PHASES.requirements_extract]),
  [COMPLETION_PHASES.requirements_extract]: Object.freeze([COMPLETION_PHASES.diff_scope]),
  [COMPLETION_PHASES.diff_scope]: Object.freeze([COMPLETION_PHASES.coverage_check]),
  [COMPLETION_PHASES.coverage_check]: Object.freeze([COMPLETION_PHASES.reuse_audit_enforcement]),
  [COMPLETION_PHASES.reuse_audit_enforcement]: Object.freeze([
    COMPLETION_PHASES.suggested_scope_enforcement,
  ]),
  [COMPLETION_PHASES.suggested_scope_enforcement]: Object.freeze([
    COMPLETION_PHASES.test_pass_crossref,
  ]),
  [COMPLETION_PHASES.test_pass_crossref]: Object.freeze([COMPLETION_PHASES.kind_checks]),
  [COMPLETION_PHASES.kind_checks]: Object.freeze([COMPLETION_PHASES.report]),
  [COMPLETION_PHASES.report]: Object.freeze([COMPLETION_PHASES.memorize]),
  [COMPLETION_PHASES.memorize]: Object.freeze([COMPLETION_PHASES.done]),
  [COMPLETION_PHASES.done]: Object.freeze([]),
});

function completionNextPhases(current) {
  return COMPLETION_PHASE_TRANSITIONS[current] || [];
}

function completionCanTransition(current, next) {
  return completionNextPhases(current).includes(next);
}

function isCompletionPhase(phase) {
  return Object.hasOwn(COMPLETION_PHASES, phase);
}

const COMPLETION_INITIAL_PHASE = COMPLETION_PHASES.inputs;
const COMPLETION_TERMINAL_PHASE = COMPLETION_PHASES.done;

module.exports = {
  COMPLETION_PHASES,
  COMPLETION_PHASE_ORDER,
  COMPLETION_PHASE_TRANSITIONS,
  COMPLETION_INITIAL_PHASE,
  COMPLETION_TERMINAL_PHASE,
  completionNextPhases,
  completionCanTransition,
  isCompletionPhase,
};
