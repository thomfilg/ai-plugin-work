/**
 * Follow-up2 step registry.
 *
 * Each step registers a handler: handler(state, ctx) → instruction | null
 * - null: step done, advance to next
 * - instruction: return to AI for delegation
 *
 * Steps can set state.currentStep to loop back (e.g., push-retry → monitor).
 */

'use strict';

const handlers = Object.create(null);

function registerStep(stepName, fn) {
  handlers[stepName] = fn;
}

function runStep(stepName, state, ctx) {
  const fn = handlers[stepName];
  if (!fn) return null;
  return fn(state, ctx);
}

const STEPS = ['monitor', 'triage', 'infra-retry', 'fix-ci', 'fix-reviews', 'push-retry', 'report'];

// Dispatch a step result and decide whether the orchestrator loop terminates.
// Exported for testability (Task 4: action:'surface' is a terminal instruction
// that stops the loop without marking state.status='complete' — see spec's
// "API/Interface Changes" section for the surface contract).
function dispatchStepResult(state, result) {
  if (result && result.action === 'surface') {
    return { terminate: true, instruction: result };
  }
  if (result && result.action === 'blocked') {
    return { terminate: true, instruction: result };
  }
  return { terminate: false, instruction: result || null };
}

// --- Register steps ---
require('./steps/monitor')(registerStep);
require('./steps/triage')(registerStep);
require('./steps/infra-retry')(registerStep);
require('./steps/fix-ci')(registerStep);
require('./steps/fix-reviews')(registerStep);
require('./steps/push-retry')(registerStep);
require('./steps/report')(registerStep);

module.exports = { registerStep, runStep, STEPS, dispatchStepResult };
