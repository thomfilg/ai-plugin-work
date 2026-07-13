/**
 * extensions/index.js — public entry point for the /work extension system.
 *
 * Composes the three Phase 1 building blocks:
 *   - `event-bus.js`  — registry + dispatch (Task 1)
 *   - `ctx.js`        — per-dispatch context factory (Task 2)
 *   - `loader.js`     — discovery, validation, error isolation (Task 3)
 *
 * Exposes `initExtensions({repoRoot, tasksDir})` returning `{dispatch, status}`:
 *   - `dispatch(eventName, payload)` builds a fresh ctx via `createCtx` and
 *     forwards to `event-bus.dispatch`.
 *   - `status()` returns the loader's `ExtensionStatusEntry[]` snapshot.
 *
 * Behavior:
 *   - Missing `.claude/work-extensions/` directory → `status() === []` and
 *     `dispatch` is a safe no-op (R8 — backward compatibility).
 *   - Result is memoized per `(repoRoot, tasksDir)` keypair, so repeated
 *     callers in the same Node process share a single registry rather than
 *     re-discovering / re-requiring extension files.
 *
 * Covers Task 4 acceptance criteria (R3, R6, R8).
 */

'use strict';

const eventBus = require('./event-bus');
const { createCtx } = require('./ctx');
const { loadExtensions } = require('./loader');
const { createDebugLog } = require('../debug-log');

/**
 * Memoization cache. Keyed by `${repoRoot}\x00${tasksDir}` so the two
 * components cannot collide via string concatenation.
 * @type {Map<string, {dispatch: Function, status: Function}>}
 */
const cache = new Map();

/** @param {string} repoRoot @param {string} tasksDir @returns {string} */
function cacheKey(repoRoot, tasksDir) {
  return `${repoRoot}\x00${tasksDir}`;
}

/**
 * Log a handler error to both the debug log and stderr without ever throwing.
 * Two independent try/catch blocks so a failure in one sink cannot suppress
 * the other.
 * @param {{error: Function}} log
 * @param {string} eventName
 * @param {Error} err
 */
function logHandlerError(log, eventName, err) {
  const message = err && err.message;
  try {
    log.error('extension handler threw', { event: eventName, message });
  } catch {
    /* fail-open */
  }
  try {
    process.stderr.write(`[work-extensions] handler error for ${eventName}: ${message}\n`);
  } catch {
    /* fail-open */
  }
}

/**
 * Initialize the extension system for a (repoRoot, tasksDir) pair.
 *
 * Discovery + registration happens exactly once per keypair per process.
 * The returned API is stable: subsequent calls with the same keypair return
 * the identical object reference.
 *
 * @param {{repoRoot: string, tasksDir: string}} opts
 * @returns {{
 *   dispatch: (eventName: string, payload: object) => Promise<void>,
 *   status: () => Array<{file: string, events: string[], loaded: boolean, error?: string}>,
 * }}
 */
function initExtensions(opts) {
  const { repoRoot, tasksDir } = opts || {};
  const key = cacheKey(repoRoot, tasksDir);

  const cached = cache.get(key);
  if (cached) return cached;

  const statusEntries = loadExtensions({ repoRoot, tasksDir, bus: eventBus });
  const log = createDebugLog(tasksDir);

  /**
   * Dispatch an event by name with a payload.
   * Builds a fresh ctx per call so handlers cannot leak state across events.
   * Safe no-op when no handlers are registered (R8). A throwing handler is
   * caught and logged so /work never crashes on a broken extension (R6).
   * @param {string} eventName
   * @param {object} payload
   * @returns {Promise<void>}
   */
  async function dispatch(eventName, payload) {
    const ctx = createCtx({ event: eventName, payload });
    try {
      await eventBus.dispatch(eventName, payload, ctx);
    } catch (err) {
      logHandlerError(log, eventName, err);
    }
  }

  /**
   * Snapshot of the loader's per-file status entries.
   * @returns {Array<{file: string, events: string[], loaded: boolean, error?: string}>}
   */
  function status() {
    return statusEntries.slice();
  }

  const api = { dispatch, status };
  cache.set(key, api);
  return api;
}

module.exports = {
  initExtensions,
};
