/**
 * ci-phase-registry.js
 *
 * Phases for the WORK orchestrator's `ci` step.
 *
 * Phases (linear):
 *   inputs → wait → triage → fix_or_document → rerun_check → memorize → done
 *
 * `wait` is a re-entrant phase: when CI is still running, validate returns
 * `{ ok: false, errors: [] }` (no errors → waiting, not blocked), so the
 * orchestrator prints the current instructions and exits without advancing.
 */

'use strict';

const CI_PHASES = Object.freeze({
  inputs: 'inputs',
  wait: 'wait',
  triage: 'triage',
  fix_or_document: 'fix_or_document',
  rerun_check: 'rerun_check',
  memorize: 'memorize',
  done: 'done',
});

const CI_PHASE_ORDER = Object.freeze([
  CI_PHASES.inputs,
  CI_PHASES.wait,
  CI_PHASES.triage,
  CI_PHASES.fix_or_document,
  CI_PHASES.rerun_check,
  CI_PHASES.memorize,
  CI_PHASES.done,
]);

const CI_PHASE_TRANSITIONS = Object.freeze({
  [CI_PHASES.inputs]: Object.freeze([CI_PHASES.wait]),
  [CI_PHASES.wait]: Object.freeze([CI_PHASES.triage]),
  [CI_PHASES.triage]: Object.freeze([CI_PHASES.fix_or_document]),
  [CI_PHASES.fix_or_document]: Object.freeze([CI_PHASES.rerun_check]),
  [CI_PHASES.rerun_check]: Object.freeze([CI_PHASES.memorize]),
  [CI_PHASES.memorize]: Object.freeze([CI_PHASES.done]),
  [CI_PHASES.done]: Object.freeze([]),
});

function ciNextPhases(c) {
  return CI_PHASE_TRANSITIONS[c] || [];
}
function ciCanTransition(c, n) {
  return ciNextPhases(c).includes(n);
}
function isCiPhase(p) {
  return Object.hasOwn(CI_PHASES, p);
}

const CI_INITIAL_PHASE = CI_PHASES.inputs;
const CI_TERMINAL_PHASE = CI_PHASES.done;

module.exports = {
  CI_PHASES,
  CI_PHASE_ORDER,
  CI_PHASE_TRANSITIONS,
  CI_INITIAL_PHASE,
  CI_TERMINAL_PHASE,
  ciNextPhases,
  ciCanTransition,
  isCiPhase,
};
