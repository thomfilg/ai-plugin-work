#!/usr/bin/env node

/**
 * pr-review-phase-state.js
 *
 * Authorized writer for `tasks/<ticket>/pr-review-phase.json`.
 *
 * Factory contract (GH-478, Task 8):
 *   This file is a thin wrapper around the `createPhaseStateCli` factory
 *   at `plugins/work/scripts/workflows/lib/phase-state/create-phase-state-cli.js`.
 *   To add a new phase-state CLI, prefer extending the factory's options
 *   (`phaseRegistry`, `allowedAgents`, `stateFileName`, `scriptName`) rather
 *   than copy-pasting the CLI body. Public re-exports (`PHASES`,
 *   `prReviewCanTransition`, `prReviewNextPhases`) and the on-disk state-file
 *   format are preserved verbatim for byte-equivalent behavior.
 *
 * Allow-list: `pr-reviewer`. Subcommands: `init`, `current`, `record`,
 * `transition`.
 */

'use strict';

const { createPhaseStateCli } = require('../lib/phase-state/create-phase-state-cli');
const {
  PR_REVIEW_PHASE_ORDER,
  PR_REVIEW_INITIAL_PHASE,
  PR_REVIEW_TERMINAL_PHASE,
  prReviewNextPhases,
  prReviewCanTransition,
  isPrReviewPhase,
} = require('./pr-review-phase-registry');

const cli = createPhaseStateCli({
  phaseRegistry: {
    PHASE_ORDER: PR_REVIEW_PHASE_ORDER,
    INITIAL_PHASE: PR_REVIEW_INITIAL_PHASE,
    TERMINAL_PHASE: PR_REVIEW_TERMINAL_PHASE,
    nextPhases: prReviewNextPhases,
    canTransition: prReviewCanTransition,
    isPhase: isPrReviewPhase,
  },
  allowedAgents: ['pr-reviewer'],
  stateFileName: 'pr-review-phase.json',
  scriptName: 'pr-review-phase-state.js',
});

if (require.main === module) {
  cli.main(process.argv);
}

module.exports = { PHASES: cli.PHASES, prReviewCanTransition, prReviewNextPhases };
