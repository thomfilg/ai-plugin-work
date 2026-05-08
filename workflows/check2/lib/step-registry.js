/**
 * Check2 step registry.
 *
 * Each step registers a handler function:
 *   handler(state, ctx) → instruction | null
 *
 * Returns:
 *   - null: step is done, auto-advance to next step
 *   - instruction object: return to AI for delegation
 *
 * Registry pattern: add new steps by creating a file in steps/
 * and registering it below. The core orchestrator (check-next.js)
 * has NO step-specific logic.
 */

'use strict';

const handlers = Object.create(null);

/**
 * Register a step handler.
 * @param {string} stepName
 * @param {(state: object, ctx: object) => object|null} fn
 */
function registerStep(stepName, fn) {
  handlers[stepName] = fn;
}

/**
 * Run a step's handler.
 * @param {string} stepName
 * @param {object} state - Check state (mutated in place, saved by caller)
 * @param {object} ctx - Context (tasksDir, checkHooksDir, etc.)
 * @returns {object|null} - instruction or null (auto-advance)
 */
function runStep(stepName, state, ctx) {
  const fn = handlers[stepName];
  if (!fn) return null; // unknown step → auto-advance
  return fn(state, ctx);
}

// ─── Step order ─────────────────────────────────────────────────────────────
const STEPS = [
  '1_setup',
  '2_start_env',
  '3_verify_playwright',
  '4_phase1_agents',
  '5_phase2_consensus',
  '6_quality_recheck',
  '7_validate_summary',
  '8_output',
];

// ─── Register steps ─────────────────────────────────────────────────────────
require('./steps/setup')(registerStep);
require('./steps/start-env')(registerStep);
require('./steps/verify-playwright')(registerStep);
require('./steps/phase1-agents')(registerStep);
require('./steps/phase2-consensus')(registerStep);
require('./steps/quality-recheck')(registerStep);
require('./steps/validate-summary')(registerStep);
require('./steps/output')(registerStep);

module.exports = { registerStep, runStep, STEPS };
