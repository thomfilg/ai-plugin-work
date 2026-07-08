#!/usr/bin/env node

/**
 * qa-phase-state.js
 *
 * Authorized writer for `tasks/<ticket>/qa-phase.json`.
 *
 * Factory contract (GH-478, Task 8):
 *   This file is a thin wrapper around the `createPhaseStateCli` factory
 *   at `plugins/work/scripts/workflows/lib/phase-state/create-phase-state-cli.js`.
 *   To add a new phase-state CLI, prefer extending the factory's options
 *   (`phaseRegistry`, `allowedAgents`, `stateFileName`, `scriptName`) rather
 *   than copy-pasting the CLI body. Public re-exports (`PHASES`,
 *   `qaCanTransition`, `qaNextPhases`) and the on-disk state-file
 *   format are preserved verbatim for byte-equivalent behavior.
 *
 * Allow-list: `qa-feature-tester`, `qa-api-tester`. Subcommands: `init`,
 * `current`, `record`, `transition`.
 */

'use strict';

const { createPhaseStateCli } = require('../lib/phase-state/create-phase-state-cli');
const {
  QA_PHASE_ORDER,
  QA_INITIAL_PHASE,
  QA_TERMINAL_PHASE,
  qaNextPhases,
  qaCanTransition,
  isQaPhase,
} = require('./qa-phase-registry');

const cli = createPhaseStateCli({
  phaseRegistry: {
    PHASE_ORDER: QA_PHASE_ORDER,
    INITIAL_PHASE: QA_INITIAL_PHASE,
    TERMINAL_PHASE: QA_TERMINAL_PHASE,
    nextPhases: qaNextPhases,
    canTransition: qaCanTransition,
    isPhase: isQaPhase,
  },
  allowedAgents: ['qa-feature-tester', 'qa-api-tester'],
  stateFileName: 'qa-phase.json',
  scriptFilename: __filename,
});

if (require.main === module) {
  cli.main(process.argv);
}

module.exports = { PHASES: cli.PHASES, qaCanTransition, qaNextPhases };
