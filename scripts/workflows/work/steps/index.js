/**
 * Step pipeline for generatePlan().
 *
 * Each step module exports (add, state, ctx) => void.
 * The pipeline is the ordered list of step handlers the thin
 * orchestrator iterates over.
 */

const ticketStep = require('./ticket');
const bootstrapStep = require('./bootstrap');
const transitionStep = require('./transition');
const briefStep = require('./brief');
const briefGateStep = require('./brief-gate');
const specStep = require('./spec');
const specGateStep = require('./spec-gate');
const tasksStep = require('./tasks'); // GH-244: specGateStep registered above (tested in step-registry.test.js)
const tasksGateStep = require('./tasks-gate');
const implementStep = require('./implement');
const commitStep = require('./commit');
const taskReviewStep = require('./task-review');
const checkStep = require('./check');
const taskAdvanceStep = require('./task-advance');
const prStep = require('./pr');
const readyStep = require('./ready');
const followUpStep = require('./follow-up');
const ciStep = require('./ci');
const cleanupStep = require('./cleanup');
const reportsStep = require('./reports');
const completeStep = require('./complete');

/**
 * Ordered pipeline of step handlers.
 * Each entry is called with (add, state, ctx).
 *
 * Note: `task-advance` is a pseudo-step that mutates the `check` entry
 * (adds nextAction/taskInfo) but does not emit its own plan entry.
 */
const STEP_PIPELINE = [
  ticketStep,
  bootstrapStep,
  transitionStep,
  briefStep,
  briefGateStep,
  specStep,
  specGateStep,
  tasksStep,
  tasksGateStep,
  implementStep,
  commitStep,
  taskReviewStep,
  checkStep,
  taskAdvanceStep,
  prStep,
  readyStep,
  followUpStep,
  ciStep,
  cleanupStep,
  reportsStep,
  completeStep,
];

module.exports = {
  STEP_PIPELINE,
  // GH-215 Task 6.1: export briefGateStep as a named handle so external
  // consumers (and tests) can reference the gate without knowing its
  // position in STEP_PIPELINE. The gate runs immediately after briefStep
  // and before specStep to block the brief → spec transition on unresolved
  // cross-ticket / architectural open questions.
  briefGateStep,
  // GH-244: export specGateStep as a named handle
  specGateStep,
  // tasks_gate: export so tests can reference the Gate C handler directly.
  tasksGateStep,
  // GH-211 Task 5.2: export taskReviewStep as a named handle so external
  // consumers (and tests) can reference the per-task review gate without
  // knowing its position in STEP_PIPELINE. The gate runs between commitStep
  // and checkStep to block check until intermediate task review passes.
  taskReviewStep,
};
