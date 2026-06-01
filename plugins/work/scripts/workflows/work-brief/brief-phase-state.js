#!/usr/bin/env node

/**
 * brief-phase-state.js
 *
 * Authorized writer for `tasks/<ticket>/brief-phase.json`.
 *
 * Factory contract (GH-478, Task 8):
 *   This file is a thin wrapper around the `createPhaseStateCli` factory
 *   at `plugins/work/scripts/workflows/lib/phase-state/create-phase-state-cli.js`.
 *   To add a new phase-state CLI, prefer extending the factory's options
 *   (`phaseRegistry`, `allowedAgents`, `stateFileName`, `scriptName`) rather
 *   than copy-pasting the CLI body. Public re-exports (`PHASES`,
 *   `briefCanTransition`, `briefNextPhases`) and the on-disk state-file
 *   format are preserved verbatim for byte-equivalent behavior.
 *
 * Allow-list: `brief-writer`. Subcommands: `init`, `current`, `record`,
 * `transition`.
 */

'use strict';

const { createPhaseStateCli } = require('../lib/phase-state/create-phase-state-cli');
const {
  BRIEF_PHASE_ORDER,
  BRIEF_INITIAL_PHASE,
  BRIEF_TERMINAL_PHASE,
  briefNextPhases,
  briefCanTransition,
  isBriefPhase,
} = require('./brief-phase-registry');

const cli = createPhaseStateCli({
  phaseRegistry: {
    PHASE_ORDER: BRIEF_PHASE_ORDER,
    INITIAL_PHASE: BRIEF_INITIAL_PHASE,
    TERMINAL_PHASE: BRIEF_TERMINAL_PHASE,
    nextPhases: briefNextPhases,
    canTransition: briefCanTransition,
    isPhase: isBriefPhase,
  },
  allowedAgents: ['brief-writer'],
  stateFileName: 'brief-phase.json',
  scriptName: 'brief-phase-state.js',
});

if (require.main === module) {
  cli.main(process.argv);
}

module.exports = { PHASES: cli.PHASES, briefCanTransition, briefNextPhases };
