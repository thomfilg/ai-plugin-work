'use strict';

/**
 * task-verify — per-task outcome verification (GH-755, epic GH-750;
 * docs/implement-outcome-verification-plan.md §5).
 *
 * Public surface:
 *   evaluate(observations, taskKind)   pure three-verdict engine
 *   buildObservations(input)           live observation collectors
 *   maybeRunShadow(input)              gate hook (WORK_TDD_MODE=shadow only)
 *   profileFor(kind)                   kind profiles as data
 */

const { evaluate, DEFAULT_COVERAGE_FLAG_THRESHOLD } = require('./verdict-engine');
const { profileFor, KIND_PROFILES } = require('./kind-profiles');
const { buildObservations } = require('./observe');
const { maybeRunShadow, runShadowVerification, shadowEnabled } = require('./shadow');
const { reapBaseWorktree } = require('./collect/base-worktree');

module.exports = {
  evaluate,
  DEFAULT_COVERAGE_FLAG_THRESHOLD,
  profileFor,
  KIND_PROFILES,
  buildObservations,
  maybeRunShadow,
  runShadowVerification,
  shadowEnabled,
  reapBaseWorktree,
};
