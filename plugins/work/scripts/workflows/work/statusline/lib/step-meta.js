'use strict';
/**
 * step-meta.js — pure helpers for the /work status bar: which step is current,
 * how far the run has progressed, and how to colour the on-step timer.
 *
 * The per-step time budgets mirror the maestro conductor's phase-registry
 * (`budgetMin`), so the bar's green/yellow/red thresholds match the same
 * "this phase is taking too long" signal the conductor nudges on. They are
 * duplicated (not imported) because the work plugin must not depend on the
 * maestro plugin.
 */

const { ALL_STEPS } = require('../../step-registry');
const { formatDurationMs } = require('../../../lib/statusline/duration');

// Minutes a step may run before the timer turns yellow. Kept in lock-step with
// plugins/maestro/scripts/lib/maestro-conduct/phase-registry.js PHASES.budgetMin.
const BUDGET_MIN = Object.freeze({
  ticket: 5,
  bootstrap: 10,
  brief: 20,
  brief_gate: 15,
  spec: 20,
  spec_gate: 15,
  tasks: 20,
  tasks_gate: 15,
  implement: 90,
  commit: 10,
  task_review: 45,
  check: 30,
  pr: 20,
  ready: 10,
  follow_up: 60,
  ci: 30,
  cleanup: 10,
  reports: 10,
  complete: 1,
});

const DEFAULT_BUDGET_MIN = 30;

// ANSI colour codes. Statuslines render SGR sequences, so the timer can carry
// the budget signal in colour the way maestro's glyph legend does.
const COLORS = Object.freeze({ green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m' });
const RESET = '\x1b[0m';

/**
 * The step the run is currently on. Prefers the `in_progress` entry in
 * `stepStatus` (the live truth); falls back to the `currentStep` index the
 * engine persists, mirroring stats.js's `ALL_STEPS[currentStep - 1]`.
 * @param {object} state parsed `.work-state.json`
 * @returns {string} step id, or 'unknown'
 */
function currentStepName(state) {
  const stepStatus = state.stepStatus || {};
  const live = ALL_STEPS.find((s) => stepStatus[s] === 'in_progress');
  if (live) return live;
  const idx = Number.isInteger(state.currentStep) ? state.currentStep : 0;
  return ALL_STEPS[idx - 1] || 'unknown';
}

/**
 * Completed / total step counts for the `(done/total)` position badge.
 * @param {object} state
 * @returns {{ completed: number, total: number }}
 */
function stepPosition(state) {
  const stepStatus = state.stepStatus || {};
  const completed = ALL_STEPS.filter((s) => stepStatus[s] === 'completed').length;
  return { completed, total: ALL_STEPS.length };
}

/**
 * Milliseconds the run has spent on the current step. Uses the last transition
 * timestamp (when the engine entered this step); falls back to lastUpdate then
 * startTime so a mid-upgrade state without the field still ticks.
 * @param {object} state
 * @param {number} now epoch ms (injectable for tests)
 * @returns {number} elapsed ms, or NaN when no anchor timestamp exists
 */
function stepElapsedMs(state, now) {
  // First PARSEABLE anchor — not first truthy: Date.parse of the epoch is 0,
  // which a `||` chain would wrongly skip.
  for (const ts of [state.lastTransitionTimestamp, state.lastUpdate, state.startTime]) {
    const anchor = Date.parse(ts);
    if (Number.isFinite(anchor)) return now - anchor;
  }
  return Number.NaN;
}

/**
 * Format an elapsed span as `<h>h <m>m` / `<m>m <s>s` / `<s>s`. Mirrors the
 * follow-up monitor's formatter but takes raw ms so `now` stays injectable.
 * @param {number} ms
 * @returns {string} '' when ms is not a finite non-negative number
 */
function formatElapsedMs(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  return formatDurationMs(ms);
}

/**
 * Wrap the on-step timer text in the budget colour for `step`:
 *   green  ≤ budget · yellow ≤ 2× budget · red > 2× budget.
 * @param {string} step
 * @param {number} elapsedMs
 * @param {string} text already-formatted elapsed string
 * @returns {string} colourised text (plain text when elapsed is unknown)
 */
function colorizeElapsed(step, elapsedMs, text) {
  if (!Number.isFinite(elapsedMs)) return text;
  const budgetMin = BUDGET_MIN[step] || DEFAULT_BUDGET_MIN;
  const elapsedMin = elapsedMs / 60000;
  let code = COLORS.green;
  if (elapsedMin > budgetMin * 2) code = COLORS.red;
  else if (elapsedMin > budgetMin) code = COLORS.yellow;
  return `${code}${text}${RESET}`;
}

module.exports = {
  BUDGET_MIN,
  currentStepName,
  stepPosition,
  stepElapsedMs,
  formatElapsedMs,
  colorizeElapsed,
};
