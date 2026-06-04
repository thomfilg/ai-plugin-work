/**
 * PR-step phase dispatcher. Mirrors work-spec/lib/phase-registry.js.
 */

'use strict';

const handlers = Object.create(null);

function registerPhase(name, handler) {
  if (
    !handler ||
    typeof handler.validate !== 'function' ||
    typeof handler.instructions !== 'function'
  ) {
    throw new Error(`Invalid phase handler for "${name}"`);
  }
  handlers[name] = handler;
}

function getPhase(name) {
  const h = handlers[name];
  if (!h) throw new Error(`No pr-step phase handler registered for "${name}"`);
  return h;
}

function hasPhase(name) {
  return Boolean(handlers[name]);
}

require('./phases/inputs')(registerPhase);
require('./phases/diff_audit')(registerPhase);
require('./phases/description_draft')(registerPhase);
require('./phases/validate_description')(registerPhase);
require('./phases/create_or_update')(registerPhase);
require('./phases/attachments')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };
