#!/usr/bin/env node

/**
 * code-phase-state.js
 *
 * Authorized writer for `tasks/<ticket>/code-phase.json`.
 *
 * Factory contract (GH-478, Task 8):
 *   This file is a thin wrapper around the `createPhaseStateCli` factory
 *   at `plugins/work/scripts/workflows/lib/phase-state/create-phase-state-cli.js`.
 *   To add a new phase-state CLI, prefer extending the factory's options
 *   (`phaseRegistry`, `allowedAgents`, `stateFileName`, `scriptName`) rather
 *   than copy-pasting the CLI body. Public re-exports (`PHASES`,
 *   `codeCanTransition`, `codeNextPhases`) and the on-disk state-file
 *   format are preserved verbatim for byte-equivalent behavior.
 *
 * Allow-list: `code-checker`. Subcommands: `init`, `current`, `record`,
 * `transition`.
 */

'use strict';

const { createPhaseStateCli } = require('../lib/phase-state/create-phase-state-cli');
const {
  CODE_PHASE_ORDER,
  CODE_INITIAL_PHASE,
  CODE_TERMINAL_PHASE,
  codeNextPhases,
  codeCanTransition,
  isCodePhase,
} = require('./code-phase-registry');

const cli = createPhaseStateCli({
  phaseRegistry: {
    PHASE_ORDER: CODE_PHASE_ORDER,
    INITIAL_PHASE: CODE_INITIAL_PHASE,
    TERMINAL_PHASE: CODE_TERMINAL_PHASE,
    nextPhases: codeNextPhases,
    canTransition: codeCanTransition,
    isPhase: isCodePhase,
  },
  allowedAgents: ['code-checker'],
  stateFileName: 'code-phase.json',
  scriptName: 'code-phase-state.js',
});

if (require.main === module) {
  cli.main(process.argv);
}

module.exports = { PHASES: cli.PHASES, codeCanTransition, codeNextPhases };
