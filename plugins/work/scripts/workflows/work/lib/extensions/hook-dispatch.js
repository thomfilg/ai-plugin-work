/**
 * hook-dispatch.js — shared marker-gated extension resolution for /work hooks.
 *
 * The PreToolUse (`work-hook.js`) and PostToolUse (`work-auto-advance.js`)
 * hooks all need the same preamble before dispatching an extension event:
 * probe for an active `/work` marker and, when present, initialize the
 * extension API. Centralizing it here removes the duplicated boilerplate the
 * static-quality gate flagged and keeps every dispatch point fail-open.
 */

'use strict';

const path = require('node:path');

/**
 * Resolve the extension API for a hook dispatch, gated on an active `/work`
 * marker. Returns the initialized api (`{dispatch, status, listHandlers}`) when
 * a marker is present, or `null` (fail-open) when absent or on any error — a
 * misbehaving extension or a marker-probe failure must never crash the hook.
 *
 * @param {{tasksDir: string, repoRoot: string}} args
 * @param {{ findActiveMarker?: Function, initExtensions?: Function }} [deps]
 *   optional dependency injection for testing
 * @returns {{dispatch: Function, status?: Function, listHandlers?: Function}|null}
 */
function resolveHookExtensions(args, deps) {
  const { tasksDir, repoRoot } = args || {};
  let marker = null;
  try {
    const findMarker =
      deps?.findActiveMarker || require(path.join(__dirname, '..', 'marker')).findActiveMarker;
    marker = findMarker(tasksDir, '.work.pid');
  } catch {
    /* fail-open */
  }
  if (!marker) return null;
  try {
    const init = deps?.initExtensions || require(path.join(__dirname, 'index')).initExtensions;
    return init({ repoRoot, tasksDir });
  } catch {
    return null;
  }
}

module.exports = { resolveHookExtensions };
