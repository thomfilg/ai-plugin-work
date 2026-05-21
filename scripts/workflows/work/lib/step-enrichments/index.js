/**
 * Step enrichments registry.
 *
 * Two extension points:
 *   1. Enrichments - mutate plan entries before instruction building
 *      (e.g., overriding prompts, changing delegation type).
 *   2. Dispatch-advance gates - called when a dispatched step's transition
 *      is blocked. Return null (no action), { recurse: true } (re-run
 *      orchestrator), or a full instruction object. All step-specific
 *      dispatch logic lives here, NOT in work-next.js.
 *
 * Registry pattern: add new enrichments/gates by creating a file in this
 * directory and registering it below. No changes needed to the core orchestrator.
 */

'use strict';

const enrichments = Object.create(null);
const gates = Object.create(null);

/**
 * Register an enrichment for a step.
 * @param {string} stepName
 * @param {(entry: object, ctx: object) => void} fn - Mutates entry in place
 */
function register(stepName, fn) {
  if (!enrichments[stepName]) enrichments[stepName] = [];
  enrichments[stepName].push(fn);
}

/**
 * Register a dispatch-advance gate for a step.
 * @param {string} stepName
 * @param {(safeName: string, ctx: object, deps: object) => null|{recurse:true}|object} fn
 */
function registerGate(stepName, fn) {
  gates[stepName] = fn;
}

/**
 * Apply all registered enrichments for an entry's step.
 * @param {object} entry - Plan entry (mutated in place)
 * @param {object} ctx - Context (tasksDir, ticket, workDir, fs, path, tp, etc.)
 */
function enrich(entry, ctx) {
  const fns = enrichments[entry.step];
  if (!fns) return;
  for (const fn of fns) {
    fn(entry, ctx);
  }
}

/**
 * Run the dispatch-advance gate for a step (if registered).
 * @param {string} stepName
 * @param {string} safeName
 * @param {object} ctx
 * @param {object} deps
 * @returns {null | { recurse: true } | object}
 */
function runGate(stepName, safeName, ctx, deps) {
  const fn = gates[stepName];
  if (!fn) return null;
  return fn(safeName, ctx, deps);
}

// --- Register built-in enrichments ---
require('./ticket')(register);
require('./related-tickets-inject')(register);
require('./brief')(register);
require('./brief-gate')(register);
require('./spec-gate')(register);
require('./context-inject')(register);
require('./tasks-scope-gate')(register);
require('./discrepancy-gate')(register);
require('./implement')(register);
require('./check')(register);
require('./follow-up')(register);
require('./complete')(register);

// --- Register dispatch-advance gates ---
const { dispatchAdvanceGate: implementGate } = require('./implement-gate');
registerGate('implement', implementGate);

const { dispatchAdvanceGate: checkGate } = require('./check-gate');
registerGate('check', checkGate);

const { dispatchAdvanceGate: followUpGate } = require('./follow-up-gate');
registerGate('follow_up', followUpGate);

const { dispatchAdvanceGate: ciGate } = require('./ci-gate');
registerGate('ci', ciGate);

module.exports = { register, registerGate, enrich, runGate };
