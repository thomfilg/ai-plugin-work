/**
 * Code-checker phase dispatcher. Mirrors work-spec/lib/phase-registry.js.
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
  if (!h) throw new Error(`No code phase handler registered for "${phaseName}"`);
  return h;
}

function hasPhase(phaseName) {
  return Boolean(handlers[phaseName]);
}

require('./phases/inputs')(registerPhase);
require('./phases/change_classify')(registerPhase);
require('./phases/file_coverage')(registerPhase);
require('./phases/standards_audit')(registerPhase);
require('./phases/kind_checks')(registerPhase);
require('./phases/report')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };
