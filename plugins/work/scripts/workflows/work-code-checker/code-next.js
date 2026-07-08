#!/usr/bin/env node
'use strict';

/**
 * code-next.js — thin wrapper over the shared phase-runner factory.
 *
 * Factory contract (see lib/phase-runner/create-phase-runner.js):
 *   createPhaseRunner({ scriptName, phaseStateCliPath, initialPhase, getPhase, usageHint })
 *   returns a `main(argv)` that orchestrates: ticket context → current phase
 *   lookup → handler.validate(ctx) → record + transition (or block) → render.
 *
 * To add a new *-next.js runner, copy this file and swap the per-workflow
 * constants below — do NOT re-inline the orchestrator body.
 */

const path = require('node:path');
const { createPhaseRunner } = require('../lib/phase-runner/create-phase-runner');
const { CODE_INITIAL_PHASE } = require('./code-phase-registry');
const { getPhase } = require('./lib/phase-registry');

const main = createPhaseRunner({
  scriptName: 'code-next.js',
  phaseStateCliPath: path.resolve(__dirname, 'code-phase-state.js'),
  initialPhase: CODE_INITIAL_PHASE,
  getPhase,
  usageHint: 'usage: code-next.js <TICKET>\n  e.g. node code-next.js ECHO-4579',
});

if (require.main === module) main(process.argv);

module.exports = { main };
