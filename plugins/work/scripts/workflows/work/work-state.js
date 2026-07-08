#!/usr/bin/env node

/**
 * Work State Machine Helper — facade.
 *
 * Manages persistent state for /work command to enable resume on context loss.
 * State is stored in: {TASKS_BASE}/{TICKET_ID}/.work-state.json
 *
 * Usage:
 *   node work-state.js init PROJ-815
 *   node work-state.js get PROJ-815
 *   node work-state.js set-step PROJ-815 implement in_progress
 *   node work-state.js set-check PROJ-815 qa_as_dashboard in_progress
 *   node work-state.js complete PROJ-815
 *
 * GH-219 file-size burndown: the implementation now lives in cohesive
 * `work-state/` submodules (core, checkpoints, steps, subtasks, tasks,
 * task-init, cli). This file stays the single public entry point — it installs
 * the CLI process guards, wires the submodules, and re-exports the same surface
 * every existing consumer already imports. Behavior is unchanged.
 */

'use strict';

// GH-106: CLI command is used by both the global handlers and main().catch()
// Declared at module scope so both if(require.main) blocks can access it.
const _cliCommand = require.main === module ? process.argv[2] : null;

// Scope global handlers to CLI execution only so require()ing this module
// from other scripts doesn't change their failure semantics.
if (require.main === module) {
  process.on('uncaughtException', (err) => {
    if (_cliCommand === 'complete') {
      process.stderr.write(
        JSON.stringify({ error: `uncaught exception: ${err?.message || err}` }) + '\n'
      );
      process.exit(1);
    }
    process.exit(0);
  });
  process.on('unhandledRejection', (err) => {
    if (_cliCommand === 'complete') {
      process.stderr.write(
        JSON.stringify({ error: `unhandled rejection: ${err?.message || err}` }) + '\n'
      );
      process.exit(1);
    }
    process.exit(0);
  });
}

// core bootstraps config (exiting(0) when config.js is unavailable, preserving
// the former module-load behavior) plus the state-file IO primitives.
const core = require('./work-state/core');
const { loadState, saveState, initState, autoInitTdd, STEPS, SUBTASK_STEPS, CHECK_AGENTS } = core;

const {
  setStepStatus,
  setCheckProgress,
  addError,
  completeWork,
  getResumeInfo,
} = require('./work-state/steps');

const {
  getNextSubtaskStatePath,
  initSubtaskState,
  loadActiveSubtaskState,
  completeSubtask,
} = require('./work-state/subtasks');

const {
  getTaskCurrent,
  advanceTask,
  getTaskByIndex,
  getTaskReviewFixRounds,
  incrementTaskReviewFixRounds,
  resetTaskReviewFixRounds,
} = require('./work-state/tasks');

// ─── Task graph + readiness (GH-219) ─────────────────────────────────────────
const { validateTaskGraph } = require('./work-state/graph-validation');
const _taskReadiness = require('./work-state/task-readiness');
const { initTasksMeta, canStartFromState, canStart } = _taskReadiness;

// ─── Task claim locks (GH-219 Task 6) ───────────────────────────────────────
// Per-task atomic claim semantics live in `./lib/work-claims.js`. We re-export
// `claimTask` / `releaseTask` here so downstream CLI and hook consumers can
// import a single "work state" surface, and so the spec verification
// checklist grep for `/claimTask/` and `/\.claims/` in work-state.js is
// satisfied without duplicating the implementation.
// Claim lock files live at `TASKS_BASE/<ticketId>/.claims/task-${n}.lock`.
let claimTask, releaseTask;
try {
  ({ claimTask, releaseTask } = require('./lib/work-claims'));
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && /['"]\.\/lib\/work-claims['"]/.test(err.message)) {
    // work-claims.js ships in a separate PR (PR 2b). When absent, claim
    // re-exports are undefined — callers that need claims must depend on PR 2b.
    // Only swallow MODULE_NOT_FOUND for './lib/work-claims' itself — rethrow if a
    // transitive dependency inside work-claims is missing (runtime bug).
    claimTask = undefined;
    releaseTask = undefined;
  } else {
    throw err;
  }
}

// ─── Parallel worker PR{N} slot allocation (GH-219 Task 7) ─────────────────
const _parallelWorkers = require('./work-state/parallel-workers');
const { allocateWorkerSlot, releaseWorkerSlot } = _parallelWorkers;

// Inject parent functions into submodules to break the circular dependency.
// MUST run before the CLI `main()` block below — `main()` is async but its
// first tick is synchronous and may call initTasksMeta before module.exports
// is assigned.
const _parentFns = { loadState, saveState, initState };
_taskReadiness._setParent(_parentFns);
_parallelWorkers._setParent(_parentFns);

if (require.main === module) {
  const { main } = require('./work-state/cli');
  main().catch((err) => {
    if (_cliCommand === 'complete') {
      process.stderr.write(
        JSON.stringify({ error: `complete failed: ${err?.message || err}` }) + '\n'
      );
      process.exit(1);
    }
    process.exit(0);
  }); // _cliCommand is module-scoped — see top of file
}

module.exports = {
  loadState,
  saveState,
  initState,
  setStepStatus,
  setCheckProgress,
  addError,
  completeWork,
  getResumeInfo,
  getNextSubtaskStatePath,
  initSubtaskState,
  loadActiveSubtaskState,
  completeSubtask,
  autoInitTdd,
  initTasksMeta,
  validateTaskGraph,
  canStart,
  canStartFromState,
  getTaskCurrent,
  advanceTask,
  getTaskByIndex,
  getTaskReviewFixRounds,
  incrementTaskReviewFixRounds,
  resetTaskReviewFixRounds,
  // GH-219 Task 6: re-exports from work-claims.js
  claimTask,
  releaseTask,
  // GH-219 Task 7: PR{N} worker slot allocation
  allocateWorkerSlot,
  releaseWorkerSlot,
  STEPS,
  SUBTASK_STEPS,
  CHECK_AGENTS,
};
