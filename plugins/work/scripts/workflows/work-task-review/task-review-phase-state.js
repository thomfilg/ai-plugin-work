#!/usr/bin/env node

/**
 * task-review-phase-state.js
 *
 * Authorized writer for `tasks/<ticket>/task-review-phase.json`.
 *
 * Factory contract (GH-478, Task 8):
 *   This file is a thin wrapper around the `createPhaseStateCli` factory
 *   at `plugins/work/scripts/workflows/lib/phase-state/create-phase-state-cli.js`.
 *   To add a new phase-state CLI, prefer extending the factory's options
 *   (`phaseRegistry`, `allowedAgents`, `stateFileName`, `scriptName`) rather
 *   than copy-pasting the CLI body. Public re-exports (`PHASES`,
 *   `taskReviewCanTransition`, `taskReviewNextPhases`) and the on-disk
 *   state-file format are preserved verbatim for byte-equivalent behavior.
 *
 * Allow-list: `task-reviewer`, `code-checker`. Subcommands: `init`,
 * `current`, `record`, `transition`.
 */

'use strict';

const { createPhaseStateCli } = require('../lib/phase-state/create-phase-state-cli');
const {
  TASK_REVIEW_PHASE_ORDER,
  TASK_REVIEW_INITIAL_PHASE,
  TASK_REVIEW_TERMINAL_PHASE,
  taskReviewNextPhases,
  taskReviewCanTransition,
  isTaskReviewPhase,
} = require('./task-review-phase-registry');

const cli = createPhaseStateCli({
  phaseRegistry: {
    PHASE_ORDER: TASK_REVIEW_PHASE_ORDER,
    INITIAL_PHASE: TASK_REVIEW_INITIAL_PHASE,
    TERMINAL_PHASE: TASK_REVIEW_TERMINAL_PHASE,
    nextPhases: taskReviewNextPhases,
    canTransition: taskReviewCanTransition,
    isPhase: isTaskReviewPhase,
  },
  allowedAgents: ['task-reviewer', 'code-checker'],
  stateFileName: 'task-review-phase.json',
  scriptFilename: __filename,
});

if (require.main === module) {
  cli.main(process.argv);
}

module.exports = { PHASES: cli.PHASES, taskReviewCanTransition, taskReviewNextPhases };
