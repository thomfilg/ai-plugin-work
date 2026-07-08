'use strict';

/**
 * synapsys-replay-next — state-machine helpers for the phase-next runner.
 *
 * Pure(ish) module: only the load/save helpers touch fs. Kept separate from
 * the script so `synapsys-replay-next.js` stays under the 400-line quality
 * cap.
 *
 * State shape (written to `<runDir>/state.json`):
 *   {
 *     version: 1,
 *     phase: 'walk' | 'judge' | 'aggregate' | 'report' | 'done',
 *     noJudge: boolean,
 *     extrapolated: boolean,
 *     batchCount: number,        // total batches scheduled
 *     pending: number[],         // batch indices not yet judged
 *     since, project, only, store, json, allProjects, maxJudges, transcriptsBase
 *   }
 */

const fs = require('node:fs');
const path = require('node:path');

const STATE_FILE = 'state.json';

function statePath(runDir) {
  return path.join(runDir, STATE_FILE);
}

function loadState(runDir) {
  const file = statePath(runDir);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(runDir, state) {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(statePath(runDir), JSON.stringify(state, null, 2));
}

function batchInPath(runDir, n) {
  return path.join(runDir, `batch-${n}.in.json`);
}

function batchOutPath(runDir, n) {
  return path.join(runDir, `batch-${n}.out.json`);
}

/**
 * Recompute the pending list against `<runDir>/batch-<n>.out.json` presence.
 * Returns the still-pending indices in ascending order.
 */
function recomputePending(runDir, batchCount) {
  const pending = [];
  for (let i = 0; i < batchCount; i++) {
    if (!fs.existsSync(batchOutPath(runDir, i))) pending.push(i);
  }
  return pending;
}

/**
 * Pick the next pending batch index (lowest) or null if none.
 */
function pickNextBatch(state) {
  if (!state || !Array.isArray(state.pending) || state.pending.length === 0) return null;
  return state.pending[0];
}

module.exports = {
  STATE_FILE,
  statePath,
  loadState,
  saveState,
  batchInPath,
  batchOutPath,
  recomputePending,
  pickNextBatch,
};
