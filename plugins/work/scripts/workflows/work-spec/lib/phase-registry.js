/**
 * Spec phase dispatcher.
 *
 * Mirrors `work-brief/lib/phase-registry.js`. Each phase registers a handler
 * shape:
 *
 *   {
 *     next: string|null,
 *     validate(ctx) => { ok, errors?: string[], warnings?: string[], summary?: string },
 *     instructions(ctx) => string,
 *   }
 *
 * The orchestrator (spec-next.js) has NO phase-specific logic — it looks
 * up the current phase here, calls validate, advances on ok, and prints
 * instructions from the (possibly new) phase.
 */

'use strict';

const handlers = Object.create(null);

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

function getPhase(phaseName) {
  const h = handlers[phaseName];
  if (!h) throw new Error(`No spec phase handler registered for "${phaseName}"`);
  return h;
}

function hasPhase(phaseName) {
  return Boolean(handlers[phaseName]);
}

require('./phases/inputs')(registerPhase);
require('./phases/reuse_audit')(registerPhase);
require('./phases/surface_audit')(registerPhase);
require('./phases/draft')(registerPhase);
require('./phases/validate')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/kind_checks')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };
