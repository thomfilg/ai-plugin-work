/**
 * skill-registry-rows.js — row factories for the skill-registry seam (GH-514).
 *
 * Each row describes a `/skill` understood by maestro-conduct:
 *   {
 *     stateFile,            // basename of the per-ticket state file
 *     snapshot(ticket),     // returns { phase, step } or null
 *     isHealthyIdle(state), // true if the raw state object is healthy-idle
 *     silenceLimitSec,      // skill-specific silence threshold default
 *   }
 *
 * The `work` row delegates to `workstate.snapshot` (single source per spec §Reuse).
 * The `follow-up` row reads `.follow-up-state.json` and maps healthy-idle statuses
 * (`awaiting_ci`, `awaiting_user`, `complete`) to `phase: 'complete'`.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const workstate = require('../workstate.js');

const FOLLOW_UP_STATE_BASENAME = '.follow-up-state.json';
const WORK_STATE_BASENAME = '.work-state' + '.json';

// Healthy-idle statuses for /follow-up. Lifted from spec §Architecture.
const FOLLOW_UP_HEALTHY_STATUSES = new Set(['awaiting_ci', 'awaiting_user', 'complete']);

// Defaults from brief P0.3 / tasks Task 1 AC.
const WORK_SILENCE_LIMIT_SEC = 300;
const FOLLOW_UP_SILENCE_LIMIT_SEC = 1800;

function tasksBase() {
  const worktrees = process.env.WORKTREES_BASE || path.join(os.homedir(), 'worktrees');
  return process.env.TASKS_BASE || path.join(worktrees, 'tasks');
}

function readFollowUpState(ticket) {
  const f = path.join(tasksBase(), ticket, FOLLOW_UP_STATE_BASENAME);
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function followUpIsHealthyIdle(state) {
  if (!state || typeof state !== 'object') return false;
  return FOLLOW_UP_HEALTHY_STATUSES.has(state.status);
}

// PR #561 review (verified safe): when /follow-up is NOT in a healthy-idle
// state we return `phase: 'follow_up'`. The conductor's phase-stall detector
// then calls `phaseFor('follow_up')` in phase-registry.js, which has an
// explicit `follow_up` row (budgetMin: 60, detectors include phaseStall) AND
// falls open to the BASE profile (with `exempts: () => false`) for any phase
// the registry doesn't know — so `handlePhaseStall` cannot crash on
// `profile.exempts` regardless of which phase string we surface here.
function followUpSnapshot(ticket) {
  const s = readFollowUpState(ticket);
  if (!s) return null;
  return {
    phase: followUpIsHealthyIdle(s) ? 'complete' : 'follow_up',
    step: typeof s.step !== 'undefined' ? s.step : null,
  };
}

function workRow() {
  return {
    stateFile: WORK_STATE_BASENAME,
    // Bind workstate.snapshot directly — single source per spec §Reuse / REFACTOR ask.
    snapshot: workstate.snapshot,
    isHealthyIdle(state) {
      // /work has no dedicated healthy-idle concept here; the existing
      // phase-stall detector handles its own healthy phases. Default false.
      return !!state && state.phase === 'complete';
    },
    silenceLimitSec: WORK_SILENCE_LIMIT_SEC,
  };
}

function followUpRow() {
  return {
    stateFile: FOLLOW_UP_STATE_BASENAME,
    snapshot: followUpSnapshot,
    isHealthyIdle: followUpIsHealthyIdle,
    silenceLimitSec: FOLLOW_UP_SILENCE_LIMIT_SEC,
  };
}

module.exports = {
  workRow,
  followUpRow,
  FOLLOW_UP_STATE_BASENAME,
  WORK_STATE_BASENAME,
  FOLLOW_UP_HEALTHY_STATUSES,
  WORK_SILENCE_LIMIT_SEC,
  FOLLOW_UP_SILENCE_LIMIT_SEC,
};
