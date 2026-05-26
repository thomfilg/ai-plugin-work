/**
 * Completion-checker phase dispatcher.
 *
 * Mirrors `work-spec/lib/phase-registry.js`. Each phase registers a handler:
 *
 *   {
 *     next: string|null,
 *     validate(ctx) => { ok, errors?: string[], warnings?: string[], summary?: string },
 *     instructions(ctx) => string,
 *   }
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
  if (!h) throw new Error(`No completion phase handler registered for "${phaseName}"`);
  return h;
}

function hasPhase(phaseName) {
  return Boolean(handlers[phaseName]);
}

require('./phases/inputs')(registerPhase);
require('./phases/requirements_extract')(registerPhase);
require('./phases/diff_scope')(registerPhase);
require('./phases/coverage_check')(registerPhase);
require('./phases/kind_checks')(registerPhase);
require('./phases/report')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };
