/**
 * Tasks phase dispatcher. Mirrors work-spec/lib/phase-registry.js.
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
  if (!h) throw new Error(`No tasks phase handler registered for "${phaseName}"`);
  return h;
}

function hasPhase(phaseName) {
  return Boolean(handlers[phaseName]);
}

require('./phases/inputs')(registerPhase);
require('./phases/requirements_extract')(registerPhase);
require('./phases/draft')(registerPhase);
require('./phases/traceability')(registerPhase);
require('./phases/kind_assign')(registerPhase);
require('./phases/scope_exists')(registerPhase);
require('./phases/gherkin_link')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };
