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
const specStep = require('./spec');
const tasksStep = require('./tasks');
const implementStep = require('./implement');
const commitStep = require('./commit');
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
  specStep,
  tasksStep,
  implementStep,
  commitStep,
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

module.exports = { STEP_PIPELINE };
