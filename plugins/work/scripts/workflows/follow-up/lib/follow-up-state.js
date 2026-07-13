/**
 * follow-up-state.js — persistence for the /follow-up orchestrator.
 *
 * Factory bound to a TASKS_BASE so the state-file path is resolved once.
 * Extracted from follow-up-next.js to keep that module under the size budget;
 * `initState` / `initFreshState` are re-exported from follow-up-next.js for
 * backward-compatible test + /reset-follow-up access.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { STEPS } = require('./step-registry');

module.exports = function createStateStore(TASKS_BASE) {
  function stateFile(ticketId) {
    return path.join(TASKS_BASE, ticketId, '.follow-up-state.json');
  }

  function loadState(ticketId) {
    try {
      return JSON.parse(fs.readFileSync(stateFile(ticketId), 'utf8'));
    } catch {
      return null;
    }
  }

  function saveState(ticketId, state) {
    const dir = path.join(TASKS_BASE, ticketId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(stateFile(ticketId), JSON.stringify(state, null, 2));
  }

  function initState(ticketId, prNumber) {
    return {
      ticketId,
      prNumber: prNumber || null,
      currentStep: STEPS[0],
      status: 'in_progress',
      dispatched: null,
      attempt: 0,
      maxAttempts: 40,
      // monitor cache (see infra-patterns.js for invalidation rules)
      // GH-531 Task 6 (AC10): explicitly reset the push-retry counter so the
      // cap-exhausted recovery path can't immediately re-trigger after
      // `reset-follow-up`. Was previously `undefined` (incremented to 1 on
      // first push-retry), which matches the same observable behavior; the
      // explicit `0` makes the recovery guarantee inspectable by operators.
      _pushRetryCount: 0,
      lastMonitorResult: null,
      lastMonitorAt: null,
      failureCategory: null,
      // Infra-retry telemetry (GH-508 Task 4). `count` tracks how many
      // infra-retry attempts have been performed for the current PR; `attempts`
      // records per-attempt diagnostics for the report step (Task 6).
      infraRetry: { count: 0, attempts: [] },
      startTime: new Date().toISOString(),
    };
  }

  /**
   * Build a fresh /follow-up state object for `ticketId`, persist it to the
   * canonical state-file path (`TASKS_BASE/<ticket>/.follow-up-state.json`),
   * and return the new state.
   *
   * Idempotent: calling twice overwrites the on-disk state with a fresh one.
   * Used both by the existing init code path and by the `/reset-follow-up`
   * command (Task 2) to re-initialize after push-retry exhaustion (GH-531).
   *
   * @param {string} ticketId — sanitized ticket id (e.g. `GH-999`).
   * @param {object} [opts] — optional overrides.
   * @param {number|null} [opts.prNumber] — preserve an existing PR number across reset.
   * @returns {object} the freshly-initialized state object.
   */
  function initFreshState(ticketId, opts) {
    const prNumber = opts && opts.prNumber != null ? opts.prNumber : null;
    const state = initState(ticketId, prNumber);
    saveState(ticketId, state);
    return state;
  }

  return { stateFile, loadState, saveState, initState, initFreshState };
};
