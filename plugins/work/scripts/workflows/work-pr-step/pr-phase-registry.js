/**
 * pr-phase-registry.js
 *
 * Phases for the WORK orchestrator's `pr` step (NOT the `/work-pr` skill at
 * `scripts/workflows/work-pr/`; that has its own internal flow). This runner
 * wraps the existing skill with explicit phase gates so PRs never ship with
 * missing sections, missing QA attachments, or a non-synced branch.
 *
 * Phases (linear):
 *   inputs → diff_audit → description_draft → validate_description →
 *   create_or_update → attachments → memorize → done
 */

'use strict';

const PR_PHASES = Object.freeze({
  inputs: 'inputs',
  diff_audit: 'diff_audit',
  description_draft: 'description_draft',
  validate_description: 'validate_description',
  create_or_update: 'create_or_update',
  attachments: 'attachments',
  memorize: 'memorize',
  done: 'done',
});

const PR_PHASE_ORDER = Object.freeze([
  PR_PHASES.inputs,
  PR_PHASES.diff_audit,
  PR_PHASES.description_draft,
  PR_PHASES.validate_description,
  PR_PHASES.create_or_update,
  PR_PHASES.attachments,
  PR_PHASES.memorize,
  PR_PHASES.done,
]);

const PR_PHASE_TRANSITIONS = Object.freeze({
  [PR_PHASES.inputs]: Object.freeze([PR_PHASES.diff_audit]),
  [PR_PHASES.diff_audit]: Object.freeze([PR_PHASES.description_draft]),
  [PR_PHASES.description_draft]: Object.freeze([PR_PHASES.validate_description]),
  [PR_PHASES.validate_description]: Object.freeze([PR_PHASES.create_or_update]),
  [PR_PHASES.create_or_update]: Object.freeze([PR_PHASES.attachments]),
  [PR_PHASES.attachments]: Object.freeze([PR_PHASES.memorize]),
  [PR_PHASES.memorize]: Object.freeze([PR_PHASES.done]),
  [PR_PHASES.done]: Object.freeze([]),
});

function prNextPhases(c) {
  return PR_PHASE_TRANSITIONS[c] || [];
}
function prCanTransition(c, n) {
  return prNextPhases(c).includes(n);
}
function isPrPhase(p) {
  return Object.hasOwn(PR_PHASES, p);
}

const PR_INITIAL_PHASE = PR_PHASES.inputs;
const PR_TERMINAL_PHASE = PR_PHASES.done;

module.exports = {
  PR_PHASES,
  PR_PHASE_ORDER,
  PR_PHASE_TRANSITIONS,
  PR_INITIAL_PHASE,
  PR_TERMINAL_PHASE,
  prNextPhases,
  prCanTransition,
  isPrPhase,
};
