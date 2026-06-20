'use strict';

/**
 * tdd-phase-state/strategy.js
 *
 * GH-610 Task 2 — Test Strategy synthesis + peer-citation evidence path,
 * extracted from tdd-phase-state.js (GH-610 static-quality refactor).
 * Flag gating, on-disk trust model, recorded-evidence shape, and emitted
 * stdout are unchanged.
 */

const path = require('path');
const { execSync } = require('child_process');
const { resolveTasksBaseWithFallback } = require('../../lib/ticket-validation');
const { sanitizeId, writeState } = require('./state-path');
const { errorExit, successOut, getCurrentCycleRecord } = require('./io');

let config;
try {
  config = require('../../lib/config');
} catch (e) {
  if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
  config = null;
}

// GH-610 Task 2 — Test Strategy synthesis + peer-citation APIs (GH-590-owned,
// consumed as stable). `synthesizeCommand` returns null for citation kinds by
// design; `validatePeerCitation` returns string[] errors (empty == valid).
let testStrategyLib;
try {
  testStrategyLib = require('../../lib/test-strategy');
} catch (e) {
  if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
  testStrategyLib = null;
}

let taskParser;
try {
  taskParser = require('../../work/lib/task-parser');
} catch (e) {
  if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
  taskParser = null;
}

const CITATION_KINDS = new Set(['verified-by', 'wiring-citation']);

/**
 * True when the GH-590 Test Strategy validator flag is enabled. Read via the
 * shared config accessor (never re-implement the flag logic). Fail-safe to
 * disabled when config is unavailable so legacy `--cmd` recording is inert.
 */
function strategyFlagOn() {
  if (config && typeof config.WORK_TEST_STRATEGY_VALIDATOR === 'string') {
    return config.WORK_TEST_STRATEGY_VALIDATOR === '1';
  }
  return process.env.WORK_TEST_STRATEGY_VALIDATOR === '1';
}

/**
 * Resolve the active task's parsed Test Strategy plus the full task list for a
 * ticket from on-disk tasks.md. Returns `{ strategy, allTasks, citingTask }` or
 * `null` when the flag is off, parsing is unavailable, the task is missing, or
 * the task has no `### Test Strategy` block. Mirrors the on-disk trust model of
 * `readActiveTaskBlock` (planner-authored, scope-guarded).
 */
/**
 * Preconditions for strategy resolution: the validator flag is on, a usable
 * task parser is available, and the ticket/task identifiers are well-formed.
 */
function strategyResolvable(ticketId, taskNum) {
  if (!strategyFlagOn()) return false;
  if (!taskParser || typeof taskParser.parseTasks !== 'function') return false;
  if (!ticketId || !Number.isInteger(taskNum) || taskNum < 1) return false;
  return true;
}

function resolveActiveTaskStrategy(ticketId, taskNum) {
  if (!strategyResolvable(ticketId, taskNum)) return null;
  try {
    const base = resolveTasksBaseWithFallback();
    const safeId = sanitizeId(ticketId);
    const tasksDir = path.resolve(base, safeId);
    const allTasks = taskParser.parseTasks(tasksDir);
    if (!Array.isArray(allTasks)) return null;
    const citingTask = allTasks.find((t) => t && t.num === taskNum);
    if (!citingTask || !citingTask.testStrategy) return null;
    return { strategy: citingTask.testStrategy, allTasks, citingTask };
  } catch {
    return null;
  }
}

/**
 * Resolve the current git SHA of the worktree as the `peerSha` provenance
 * stamp for a citation evidence entry. Best-effort: returns 'unknown' when git
 * is unavailable so the citation path never wedges on a missing SHA.
 */
function resolvePeerSha() {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Record peer-citation evidence for a `verified-by` / `wiring-citation` task.
 *
 * For citation kinds `synthesizeCommand` returns null by design — there is no
 * command to run. Instead we validate the peer pointer via
 * `validatePeerCitation`. On an empty error array we persist a green evidence
 * entry `{ kind, peer, peerSha, scopeOverlap: true, recordedAt }` (no command
 * executed). On non-empty errors we surface the strings and record nothing.
 *
 * @param {string} ticketId
 * @param {object} state - mutable phase state (will be written on success)
 * @param {{strategy:object, allTasks:object[], citingTask:object}} resolved
 * @param {object|undefined} opts - state-path opts (taskNum)
 * @returns {boolean} true when evidence was recorded (caller returns)
 */
function recordCitationEvidence(ticketId, state, resolved, opts) {
  const { strategy, allTasks, citingTask } = resolved;
  const errors = testStrategyLib.validatePeerCitation(strategy, allTasks, citingTask);
  if (Array.isArray(errors) && errors.length > 0) {
    errorExit(errors.join('\n'));
  }
  const record = getCurrentCycleRecord(state);
  record.green = {
    kind: strategy.kind,
    peer: strategy.peer || strategy.verifiedBy,
    peerSha: resolvePeerSha(),
    scopeOverlap: true,
    recordedAt: new Date().toISOString(),
  };
  writeState(ticketId, state, opts);
  successOut({
    ok: true,
    phase: 'green',
    cycle: state.currentCycle,
    citation: true,
    kind: record.green.kind,
    peer: record.green.peer,
  });
  return true;
}

module.exports = {
  testStrategyLib,
  CITATION_KINDS,
  strategyFlagOn,
  resolveActiveTaskStrategy,
  resolvePeerSha,
  recordCitationEvidence,
};
