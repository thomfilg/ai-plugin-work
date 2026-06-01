#!/usr/bin/env node

/**
 * completion-phase-state.js
 *
 * Authorized writer for `tasks/<ticket>/completion-phase.json`.
 *
 * Factory contract (GH-478, Task 8):
 *   This file is a thin wrapper around the `createPhaseStateCli` factory
 *   at `plugins/work/scripts/workflows/lib/phase-state/create-phase-state-cli.js`.
 *   To add a new phase-state CLI, prefer extending the factory's options
 *   (`phaseRegistry`, `allowedAgents`, `stateFileName`, `scriptName`) rather
 *   than copy-pasting the CLI body. Public re-exports (`PHASES`,
 *   `completionCanTransition`, `completionNextPhases`) and the on-disk
 *   state-file format are preserved verbatim for byte-equivalent behavior.
 *
 * Allow-list: `completion-checker`. Subcommands: `init`, `current`, `record`,
 * `transition`.
 */

'use strict';

const { createPhaseStateCli } = require('../lib/phase-state/create-phase-state-cli');
const {
  COMPLETION_PHASE_ORDER,
  COMPLETION_INITIAL_PHASE,
  COMPLETION_TERMINAL_PHASE,
  completionNextPhases,
  completionCanTransition,
  isCompletionPhase,
} = require('./completion-phase-registry');

const cli = createPhaseStateCli({
  phaseRegistry: {
    PHASE_ORDER: COMPLETION_PHASE_ORDER,
    INITIAL_PHASE: COMPLETION_INITIAL_PHASE,
    TERMINAL_PHASE: COMPLETION_TERMINAL_PHASE,
    nextPhases: completionNextPhases,
    canTransition: completionCanTransition,
    isPhase: isCompletionPhase,
  },
  allowedAgents: ['completion-checker'],
  stateFileName: 'completion-phase.json',
  scriptFilename: __filename,
});

if (require.main === module) {
  cli.main(process.argv);
}

module.exports = { PHASES: cli.PHASES, completionCanTransition, completionNextPhases };
