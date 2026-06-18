/**
 * Shared factory for the per-subsystem phase dispatcher.
 *
 * Every workflow subsystem (brief, spec, ci, cleanup, code-checker, …) carried
 * an identical `registerPhase` / `getPhase` / `hasPhase` trio that differed
 * only in the label baked into the "no handler registered" error. This factory
 * collapses them into one implementation: a registry module calls
 * `makePhaseRegistry('<label>')`, then wires its own phases onto the returned
 * `registerPhase`.
 *
 * Handler shape (unchanged):
 *   {
 *     next: string|null,
 *     validate(ctx) => { ok, errors?: string[], warnings?: string[], summary?: string },
 *     instructions(ctx) => string,
 *   }
 */

'use strict';

/**
 * @param {string} label — subsystem name surfaced in the lookup error
 *   (e.g. 'spec', 'task-review'); only affects the thrown message.
 * @returns {{ registerPhase: Function, getPhase: Function, hasPhase: Function }}
 */
function makePhaseRegistry(label) {
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
    if (!h) throw new Error(`No ${label} phase handler registered for "${phaseName}"`);
    return h;
  }

  function hasPhase(phaseName) {
    return Boolean(handlers[phaseName]);
  }

  return { registerPhase, getPhase, hasPhase };
}

module.exports = { makePhaseRegistry };
