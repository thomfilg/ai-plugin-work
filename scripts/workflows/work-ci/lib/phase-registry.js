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
  if (!h) throw new Error(`No ci phase handler registered for "${name}"`);
  return h;
}

function hasPhase(name) {
  return Boolean(handlers[name]);
}

require('./phases/inputs')(registerPhase);
require('./phases/wait')(registerPhase);
require('./phases/triage')(registerPhase);
require('./phases/fix_or_document')(registerPhase);
require('./phases/rerun_check')(registerPhase);
require('./phases/memorize')(registerPhase);
require('./phases/done')(registerPhase);

module.exports = { registerPhase, getPhase, hasPhase };
