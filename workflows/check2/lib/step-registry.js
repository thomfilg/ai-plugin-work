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
  '4_run_tests',           // unit tests (affected-only if SCRIPT_RUN_AFFECTED_UNIT set)
  '5_phase1_agents',       // code-checker + completion-checker
  '6_phase2_consensus',    // re-review loop if NEEDS_WORK
  '7_quality_recheck',     // verify reports APPROVED
  '8_run_integration',     // integration tests (skipped if env var not set)
  '9_run_e2e',             // e2e tests (skipped if env var not set)
  '10_validate_summary',
  '11_output',
];

// ─── Register steps ─────────────────────────────────────────────────────────
require('./steps/setup')(registerStep);
require('./steps/start-env')(registerStep);
require('./steps/verify-playwright')(registerStep);
require('./steps/run-tests')(registerStep);
require('./steps/phase1-agents')(registerStep);
require('./steps/phase2-consensus')(registerStep);
require('./steps/quality-recheck')(registerStep);
require('./steps/run-integration')(registerStep);
require('./steps/run-e2e')(registerStep);
require('./steps/validate-summary')(registerStep);
require('./steps/output')(registerStep);

module.exports = { registerStep, runStep, STEPS };
