/**
 * Step enrichments registry.
 *
 * Each enrichment is a function(entry, ctx) that modifies the plan entry
 * before instruction building (e.g., overriding prompts, changing delegation type).
 *
 * Registry pattern: add new enrichments by creating a file in this directory
 * and registering it below. No changes needed to the core orchestrator.
 */

'use strict';

const enrichments = Object.create(null);

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

// ─── Register built-in enrichments ─���────────────────────────────────────────
require('./ticket')(register);
require('./brief-gate')(register);
require('./context-inject')(register);

module.exports = { register, enrich };
