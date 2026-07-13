#!/usr/bin/env node

/**
 * tasks-phase-state.js
 *
 * Authorized writer for `tasks/<ticket>/tasks-phase.json`.
 *
 * Factory contract (GH-478, Task 7):
 *   This file is now a thin wrapper around the `createPhaseStateCli` factory
 *   at `plugins/work/scripts/workflows/lib/phase-state/create-phase-state-cli.js`.
 *   To add a new phase-state CLI, prefer extending the factory's options
 *   (`phaseRegistry`, `allowedAgents`, `stateFileName`, `scriptName`) rather
 *   than copy-pasting the CLI body. Public re-exports (`PHASES`,
 *   `tasksCanTransition`, `tasksNextPhases`) and the on-disk state-file
 *   format are preserved verbatim for byte-equivalent behavior.
 *
 * Allow-list: `split-in-tasks`. Subcommands: `init`, `current`, `record`,
 * `transition`.
 */

'use strict';

const { createPhaseStateCli } = require('../lib/phase-state/create-phase-state-cli');
const {
  TASKS_PHASE_ORDER,
  TASKS_INITIAL_PHASE,
  TASKS_TERMINAL_PHASE,
  tasksNextPhases,
  tasksCanTransition,
  isTasksPhase,
} = require('./tasks-phase-registry');

const cli = createPhaseStateCli({
  phaseRegistry: {
    PHASE_ORDER: TASKS_PHASE_ORDER,
    INITIAL_PHASE: TASKS_INITIAL_PHASE,
    TERMINAL_PHASE: TASKS_TERMINAL_PHASE,
    nextPhases: tasksNextPhases,
    canTransition: tasksCanTransition,
    isPhase: isTasksPhase,
  },
  allowedAgents: ['split-in-tasks'],
  stateFileName: 'tasks-phase.json',
  scriptFilename: __filename,
});

if (require.main === module) {
  cli.main(process.argv);
}

module.exports = { PHASES: cli.PHASES, tasksCanTransition, tasksNextPhases };
