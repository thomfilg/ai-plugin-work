/**
 * Brief phase dispatcher.
 *
 * Mirrors check2/lib/step-registry.js. Each phase registers a handler shape:
 *
 *   {
 *     next: string|null,                              // next phase to transition to, or null (terminal)
 *     validate(ctx) => { ok, errors?: string[], summary?: string },
 *     instructions(ctx) => string                     // markdown printed to agent
 *   }
 *
 * The orchestrator (brief-next.js) has NO phase-specific logic — it looks
 * up the current phase here, calls validate, advances on ok, and prints
 * instructions from the (possibly new) phase.
 *
 * Add a new phase by creating `phases/<name>.js` and `require`-ing it below.
 */

'use strict';

const handlers = Object.create(null);

/**
 * @param {string} phaseName
 * @param {{
 *   next: string|null,
 *   validate: (ctx: object) => { ok: boolean, errors?: string[], summary?: string },
 *   instructions: (ctx: object) => string,
 * }} handler
 */
function registerPhase(phaseName, handler) {
  if (
    !handler ||
    typeof handler.validate !== 'function' ||
    typeof handler.instructions !== 'function'
  ) {
    throw new Error(
      `Invalid phase handler for "${phaseName}" — must expose validate() and instructions()`
    );
  }
  handlers[phaseName] = handler;
}

/**
 * Look up a phase handler. Throws if the phase is unknown — callers should
 * only ever pass a phase name from brief-phase-registry.js's BRIEF_PHASES.
 */
function getPhase(phaseName) {
  const h = handlers[phaseName];
  if (!h) throw new Error(`No brief phase handler registered for "${phaseName}"`);
  return h;
}

function hasPhase(phaseName) {
  return Boolean(handlers[phaseName]);
}

// ─── Register all phases ────────────────────────────────────────────────────
require('./phases/inputs')(registerPhase);
require('./phases/overlap')(registerPhase);
require('./phases/draft')(registerPhase);
require('./phases/validate')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };
