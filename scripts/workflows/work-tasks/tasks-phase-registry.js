/**
 * tasks-phase-registry.js
 *
 * Central registry for tasks-phase definitions, ordering, and transitions.
 * Mirrors brief-phase-registry.js / spec-phase-registry.js.
 *
 * Phases (linear):
 *   inputs → requirements_extract → draft → traceability → kind_assign →
 *   gherkin_link → memorize → done
 *
 * `done` is terminal — no outgoing edges.
 */

'use strict';

const TASKS_PHASES = Object.freeze({
  inputs: 'inputs',
  requirements_extract: 'requirements_extract',
  draft: 'draft',
  traceability: 'traceability',
  kind_assign: 'kind_assign',
  gherkin_link: 'gherkin_link',
  memorize: 'memorize',
  done: 'done',
});

const TASKS_PHASE_ORDER = Object.freeze([
  TASKS_PHASES.inputs,
  TASKS_PHASES.requirements_extract,
  TASKS_PHASES.draft,
  TASKS_PHASES.traceability,
  TASKS_PHASES.kind_assign,
  TASKS_PHASES.gherkin_link,
  TASKS_PHASES.memorize,
  TASKS_PHASES.done,
]);

const TASKS_PHASE_TRANSITIONS = Object.freeze({
  [TASKS_PHASES.inputs]: Object.freeze([TASKS_PHASES.requirements_extract]),
  [TASKS_PHASES.requirements_extract]: Object.freeze([TASKS_PHASES.draft]),
  [TASKS_PHASES.draft]: Object.freeze([TASKS_PHASES.traceability]),
  [TASKS_PHASES.traceability]: Object.freeze([TASKS_PHASES.kind_assign]),
  [TASKS_PHASES.kind_assign]: Object.freeze([TASKS_PHASES.gherkin_link]),
  [TASKS_PHASES.gherkin_link]: Object.freeze([TASKS_PHASES.memorize]),
  [TASKS_PHASES.memorize]: Object.freeze([TASKS_PHASES.done]),
  [TASKS_PHASES.done]: Object.freeze([]),
});

function tasksNextPhases(current) {
  return TASKS_PHASE_TRANSITIONS[current] || [];
}

function tasksCanTransition(current, next) {
  return tasksNextPhases(current).includes(next);
}

function isTasksPhase(phase) {
  return Object.hasOwn(TASKS_PHASES, phase);
}

const TASKS_INITIAL_PHASE = TASKS_PHASES.inputs;
const TASKS_TERMINAL_PHASE = TASKS_PHASES.done;

module.exports = {
  TASKS_PHASES,
  TASKS_PHASE_ORDER,
  TASKS_PHASE_TRANSITIONS,
  TASKS_INITIAL_PHASE,
  TASKS_TERMINAL_PHASE,
  tasksNextPhases,
  tasksCanTransition,
  isTasksPhase,
};
