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

const STEPS = ['monitor', 'triage', 'fix-ci', 'fix-reviews', 'push-retry', 'report'];

// --- Register steps ---
require('./steps/monitor')(registerStep);
require('./steps/triage')(registerStep);
require('./steps/fix-ci')(registerStep);
require('./steps/fix-reviews')(registerStep);
require('./steps/push-retry')(registerStep);
require('./steps/report')(registerStep);

module.exports = { registerStep, runStep, STEPS };
