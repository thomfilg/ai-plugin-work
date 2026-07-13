/**
 * code-phase-registry.js
 *
 * Central registry for code-checker phase definitions, ordering, and
 * transitions. Mirrors `work-spec/spec-phase-registry.js`.
 *
 * Phases (linear):
 *   inputs → change_classify → file_coverage → standards_audit →
 *   kind_checks → report → memorize → done
 *
 * `done` is terminal.
 */

'use strict';

const CODE_PHASES = Object.freeze({
  inputs: 'inputs',
  change_classify: 'change_classify',
  file_coverage: 'file_coverage',
  standards_audit: 'standards_audit',
  kind_checks: 'kind_checks',
  report: 'report',
  memorize: 'memorize',
  done: 'done',
});

const CODE_PHASE_ORDER = Object.freeze([
  CODE_PHASES.inputs,
  CODE_PHASES.change_classify,
  CODE_PHASES.file_coverage,
  CODE_PHASES.standards_audit,
  CODE_PHASES.kind_checks,
  CODE_PHASES.report,
  CODE_PHASES.memorize,
  CODE_PHASES.done,
]);

const CODE_PHASE_TRANSITIONS = Object.freeze({
  [CODE_PHASES.inputs]: Object.freeze([CODE_PHASES.change_classify]),
  [CODE_PHASES.change_classify]: Object.freeze([CODE_PHASES.file_coverage]),
  [CODE_PHASES.file_coverage]: Object.freeze([CODE_PHASES.standards_audit]),
  [CODE_PHASES.standards_audit]: Object.freeze([CODE_PHASES.kind_checks]),
  [CODE_PHASES.kind_checks]: Object.freeze([CODE_PHASES.report]),
  [CODE_PHASES.report]: Object.freeze([CODE_PHASES.memorize]),
  [CODE_PHASES.memorize]: Object.freeze([CODE_PHASES.done]),
  [CODE_PHASES.done]: Object.freeze([]),
});

function codeNextPhases(current) {
  return CODE_PHASE_TRANSITIONS[current] || [];
}

function codeCanTransition(current, next) {
  return codeNextPhases(current).includes(next);
}

function isCodePhase(phase) {
  return Object.hasOwn(CODE_PHASES, phase);
}

const CODE_INITIAL_PHASE = CODE_PHASES.inputs;
const CODE_TERMINAL_PHASE = CODE_PHASES.done;

module.exports = {
  CODE_PHASES,
  CODE_PHASE_ORDER,
  CODE_PHASE_TRANSITIONS,
  CODE_INITIAL_PHASE,
  CODE_TERMINAL_PHASE,
  codeNextPhases,
  codeCanTransition,
  isCodePhase,
};
