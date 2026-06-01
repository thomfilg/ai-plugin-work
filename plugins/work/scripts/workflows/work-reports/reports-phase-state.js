#!/usr/bin/env node

/**
 * reports-phase-state.js
 *
 * Authorized writer for `tasks/<ticket>/reports-phase.json`.
 *
 * Factory contract (GH-478, Task 8):
 *   This file is a thin wrapper around the `createPhaseStateCli` factory
 *   at `plugins/work/scripts/workflows/lib/phase-state/create-phase-state-cli.js`.
 *   To add a new phase-state CLI, prefer extending the factory's options
 *   (`phaseRegistry`, `allowedAgents`, `stateFileName`, `scriptName`) rather
 *   than copy-pasting the CLI body. Public re-exports (`PHASES`,
 *   `reportsCanTransition`, `reportsNextPhases`) and the on-disk state-file
 *   format are preserved verbatim for byte-equivalent behavior.
 *
 * Allow-list: `reports-writer`. Subcommands: `init`, `current`, `record`,
 * `transition`.
 */

'use strict';

const { createPhaseStateCli } = require('../lib/phase-state/create-phase-state-cli');
const {
  REPORTS_PHASE_ORDER,
  REPORTS_INITIAL_PHASE,
  REPORTS_TERMINAL_PHASE,
  reportsNextPhases,
  reportsCanTransition,
  isReportsPhase,
} = require('./reports-phase-registry');

const cli = createPhaseStateCli({
  phaseRegistry: {
    PHASE_ORDER: REPORTS_PHASE_ORDER,
    INITIAL_PHASE: REPORTS_INITIAL_PHASE,
    TERMINAL_PHASE: REPORTS_TERMINAL_PHASE,
    nextPhases: reportsNextPhases,
    canTransition: reportsCanTransition,
    isPhase: isReportsPhase,
  },
  allowedAgents: ['reports-writer'],
  stateFileName: 'reports-phase.json',
  scriptName: 'reports-phase-state.js',
});

if (require.main === module) {
  cli.main(process.argv);
}

module.exports = { PHASES: cli.PHASES, reportsCanTransition, reportsNextPhases };
