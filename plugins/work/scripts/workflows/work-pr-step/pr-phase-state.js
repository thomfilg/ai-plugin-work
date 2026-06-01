#!/usr/bin/env node

/**
 * pr-phase-state.js
 *
 * Authorized writer for `tasks/<ticket>/pr-phase.json`.
 *
 * Factory contract (GH-478, Task 8):
 *   This file is a thin wrapper around the `createPhaseStateCli` factory
 *   at `plugins/work/scripts/workflows/lib/phase-state/create-phase-state-cli.js`.
 *   To add a new phase-state CLI, prefer extending the factory's options
 *   (`phaseRegistry`, `allowedAgents`, `stateFileName`, `scriptName`) rather
 *   than copy-pasting the CLI body. Public re-exports (`PHASES`,
 *   `prCanTransition`, `prNextPhases`) and the on-disk state-file
 *   format are preserved verbatim for byte-equivalent behavior.
 *
 * Allow-list: `pr-generator`, `pr-post-generator`. Subcommands: `init`,
 * `current`, `record`, `transition`.
 */

'use strict';

const { createPhaseStateCli } = require('../lib/phase-state/create-phase-state-cli');
const {
  PR_PHASE_ORDER,
  PR_INITIAL_PHASE,
  PR_TERMINAL_PHASE,
  prNextPhases,
  prCanTransition,
  isPrPhase,
} = require('./pr-phase-registry');

const cli = createPhaseStateCli({
  phaseRegistry: {
    PHASE_ORDER: PR_PHASE_ORDER,
    INITIAL_PHASE: PR_INITIAL_PHASE,
    TERMINAL_PHASE: PR_TERMINAL_PHASE,
    nextPhases: prNextPhases,
    canTransition: prCanTransition,
    isPhase: isPrPhase,
  },
  allowedAgents: ['pr-generator', 'pr-post-generator'],
  stateFileName: 'pr-phase.json',
  scriptName: 'pr-phase-state.js',
});

if (require.main === module) {
  cli.main(process.argv);
}

module.exports = { PHASES: cli.PHASES, prCanTransition, prNextPhases };
