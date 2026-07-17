/**
 * rulesync-redirect — Phase-3 reference /work extension.
 *
 * Declares a Phase-3 event (`OnReadDenied`) so this file is registered-but-inert
 * when loaded against a Phase-1 event bus. The module emits a one-time
 * "Phase 3 not yet enabled" notice at require() time so operators can see that
 * the redirect is wired but waiting on host support.
 *
 * See: plugins/work/docs/work-extensions.md
 */

'use strict';

try {
  process.stderr.write(
    '[work-extensions] rulesync-redirect: Phase 3 not yet enabled — registers-but-inert.\n'
  );
} catch {
  /* fail-open */
}

module.exports = {
  events: ['OnReadDenied'],
  /**
   * Phase-3 handler. Phase-1 dispatchers never fire this event, so the handler
   * is effectively dead code today; it is kept here as the worked example for
   * extension authors targeting the future read-deny redirect surface.
   *
   * @param {object} _payload
   * @param {{passthrough: () => void}} ctx
   */
  handler(_payload, ctx) {
    ctx.passthrough();
  },
  priority: 50,
};
