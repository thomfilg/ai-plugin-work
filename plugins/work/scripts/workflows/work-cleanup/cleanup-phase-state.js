#!/usr/bin/env node

/**
 * cleanup-phase-state.js
 *
 * Authorized writer for `tasks/<ticket>/cleanup-phase.json`.
 *
 * Factory contract (GH-478, Task 8):
 *   This file is a thin wrapper around the `createPhaseStateCli` factory
 *   at `plugins/work/scripts/workflows/lib/phase-state/create-phase-state-cli.js`.
 *   To add a new phase-state CLI, prefer extending the factory's options
 *   (`phaseRegistry`, `allowedAgents`, `stateFileName`, `scriptName`) rather
 *   than copy-pasting the CLI body. Public re-exports (`PHASES`,
 *   `cleanupCanTransition`, `cleanupNextPhases`) and the on-disk state-file
 *   format are preserved verbatim for byte-equivalent behavior.
 *
 * Allow-list: `cleanup-runner`. Subcommands: `init`, `current`, `record`,
 * `transition`.
 */

'use strict';

const { createPhaseStateCli } = require('../lib/phase-state/create-phase-state-cli');
const {
  CLEANUP_PHASE_ORDER,
  CLEANUP_INITIAL_PHASE,
  CLEANUP_TERMINAL_PHASE,
  cleanupNextPhases,
  cleanupCanTransition,
  isCleanupPhase,
} = require('./cleanup-phase-registry');

const cli = createPhaseStateCli({
  phaseRegistry: {
    PHASE_ORDER: CLEANUP_PHASE_ORDER,
    INITIAL_PHASE: CLEANUP_INITIAL_PHASE,
    TERMINAL_PHASE: CLEANUP_TERMINAL_PHASE,
    nextPhases: cleanupNextPhases,
    canTransition: cleanupCanTransition,
    isPhase: isCleanupPhase,
  },
  allowedAgents: ['cleanup-runner'],
  stateFileName: 'cleanup-phase.json',
  scriptName: 'cleanup-phase-state.js',
});

if (require.main === module) {
  cli.main(process.argv);
}

module.exports = { PHASES: cli.PHASES, cleanupCanTransition, cleanupNextPhases };
