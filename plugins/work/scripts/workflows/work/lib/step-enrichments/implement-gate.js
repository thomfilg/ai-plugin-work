/**
 * Implement multi-task gate.
 *
 * Handles task-advance when the current task's TDD evidence is valid
 * and more tasks remain. Returns { recurse: true } to re-dispatch
 * the next task, or null to let work-next.js handle re-dispatch.
 *
 * This gate works WITH the multi-task guard in transition-step.js:
 *   - transition-step.js BLOCKS implement→commit when tasks remain
 *   - This gate ADVANCES the task pointer when evidence is valid
 *
 * When evidence is missing or invalid, returns null so work-next.js
 * falls through and re-dispatches the full implementation prompt
 * (which already includes TDD evidence instructions).
 *
 * The implementation is split across the `implement-gate/` directory to keep
 * each module within the static-quality budget; this file is the stable public
 * surface that wires those modules back together:
 *   - implement-gate/advance-gate.js  — the dispatch-advance gate state machine
 *   - implement-gate/test-command.js  — test-command / test-strategy resolution
 *   - implement-gate/test-runner.js   — pre/post-implement test execution + evidence
 *   - implement-gate/reconcile.js     — tasksMeta ↔ tasks.md reconciliation
 */

'use strict';

const path = require('path');

const { dispatchAdvanceGate } = require(path.join(__dirname, 'implement-gate', 'advance-gate'));
const { readTaskTestCommand, resolveTaskTestExecution } = require(
  path.join(__dirname, 'implement-gate', 'test-command')
);
const {
  runPreImplementTest,
  runTestAndRecord,
  isE2eCommand,
  shouldSkipTestExecution,
  writeSkipStubEvidence,
} = require(path.join(__dirname, 'implement-gate', 'test-runner'));

module.exports = {
  dispatchAdvanceGate,
  runPreImplementTest,
  runTestAndRecord,
  isE2eCommand,
  shouldSkipTestExecution,
  writeSkipStubEvidence,
  readTaskTestCommand,
  resolveTaskTestExecution,
};
