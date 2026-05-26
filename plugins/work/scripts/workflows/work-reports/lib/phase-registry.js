/**
 * Reports phase dispatcher. Mirrors work-pr-reviewer/lib/phase-registry.js
 * but without a per-kind branch.
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
  if (!h) throw new Error(`No reports phase handler registered for "${phaseName}"`);
  return h;
}

function hasPhase(phaseName) {
  return Boolean(handlers[phaseName]);
}

require('./phases/inputs')(registerPhase);
require('./phases/collect_artifacts')(registerPhase);
require('./phases/summarize')(registerPhase);
require('./phases/emit')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };
