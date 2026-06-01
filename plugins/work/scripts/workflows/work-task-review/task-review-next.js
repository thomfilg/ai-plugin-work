#!/usr/bin/env node
'use strict';

/**
 * task-review-next.js — thin wrapper over the shared phase-runner factory.
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
const { TASK_REVIEW_INITIAL_PHASE } = require('./task-review-phase-registry');
const { getPhase } = require('./lib/phase-registry');

const main = createPhaseRunner({
  scriptName: 'task-review-next.js',
  phaseStateCliPath: path.resolve(__dirname, 'task-review-phase-state.js'),
  initialPhase: TASK_REVIEW_INITIAL_PHASE,
  getPhase,
  usageHint: 'usage: task-review-next.js <TICKET>\n  e.g. node task-review-next.js ECHO-4579',
});

if (require.main === module) main(process.argv);

module.exports = { main };
