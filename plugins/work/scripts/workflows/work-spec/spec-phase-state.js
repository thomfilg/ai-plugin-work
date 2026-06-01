#!/usr/bin/env node

/**
 * spec-phase-state.js
 *
 * Authorized writer for `tasks/<ticket>/spec-phase.json`.
 *
 * Factory contract (GH-478, Task 8):
 *   This file is a thin wrapper around the `createPhaseStateCli` factory
 *   at `plugins/work/scripts/workflows/lib/phase-state/create-phase-state-cli.js`.
 *   To add a new phase-state CLI, prefer extending the factory's options
 *   (`phaseRegistry`, `allowedAgents`, `stateFileName`, `scriptName`) rather
 *   than copy-pasting the CLI body. Public re-exports (`PHASES`,
 *   `specCanTransition`, `specNextPhases`) and the on-disk state-file
 *   format are preserved verbatim for byte-equivalent behavior.
 *
 * Allow-list: `spec-writer`. Subcommands: `init`, `current`, `record`,
 * `transition`.
 */

'use strict';

const { createPhaseStateCli } = require('../lib/phase-state/create-phase-state-cli');
const {
  SPEC_PHASE_ORDER,
  SPEC_INITIAL_PHASE,
  SPEC_TERMINAL_PHASE,
  specNextPhases,
  specCanTransition,
  isSpecPhase,
} = require('./spec-phase-registry');

const cli = createPhaseStateCli({
  phaseRegistry: {
    PHASE_ORDER: SPEC_PHASE_ORDER,
    INITIAL_PHASE: SPEC_INITIAL_PHASE,
    TERMINAL_PHASE: SPEC_TERMINAL_PHASE,
    nextPhases: specNextPhases,
    canTransition: specCanTransition,
    isPhase: isSpecPhase,
  },
  allowedAgents: ['spec-writer'],
  stateFileName: 'spec-phase.json',
  scriptName: 'spec-phase-state.js',
});

if (require.main === module) {
  cli.main(process.argv);
}

module.exports = { PHASES: cli.PHASES, specCanTransition, specNextPhases };
