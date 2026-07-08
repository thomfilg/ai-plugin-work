/**
 * Kind-check registry. Mirrors the phase-registry pattern at a sub-level.
 *
 * Each kind module exports a `register` function. Each kind handler has:
 *   - appliesTo(ctx) → boolean
 *   - validate(ctx)  → { ok, errors?, warnings?, summary? }
 */

'use strict';

const registry = Object.create(null);

function registerKind(name, handler) {
  if (
    !handler ||
    typeof handler.appliesTo !== 'function' ||
    typeof handler.validate !== 'function'
  ) {
    throw new Error(`Invalid kind handler for "${name}" — must expose appliesTo() and validate()`);
  }
  registry[name] = handler;
}

function getKindCheckRegistry() {
  return registry;
}

require('./frontend')(registerKind);
require('./backend')(registerKind);
require('./wiring')(registerKind);
require('./e2e')(registerKind);
require('./devops')(registerKind);
require('./fullstack')(registerKind);

module.exports = { registerKind, getKindCheckRegistry };
