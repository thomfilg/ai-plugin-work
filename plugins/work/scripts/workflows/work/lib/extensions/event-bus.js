/**
 * event-bus.js — pure in-memory registry + dispatcher for /work extensions.
 *
 * Responsibilities (Task 1 / R9 / G6):
 *   - register({eventName, handler, priority?, sourceFile, match?})
 *   - dispatch(eventName, payload, ctx) iterates handlers in order, awaits each
 *   - listHandlers(eventName) returns the ordered handler records
 *
 * Ordering rules:
 *   - Default priority is 50.
 *   - Higher priority runs first (descending).
 *   - Equal priority is broken lexically by sourceFile ascending.
 *
 * No I/O — pure registry. Discovery/loading lives in loader.js (Task 3).
 */

'use strict';

const path = require('node:path');

// Resolve synapsys safeRegex lazily so this module remains side-effect-free
// at require time even if synapsys is not installed in some test contexts.
function getSafeRegex() {
  try {
    // plugins/work/scripts/workflows/work/lib/extensions/ → ../../../../../../synapsys/lib/matcher
    // (6 levels: extensions → lib → work → workflows → scripts → work → plugins)
    const matcherPath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      '..',
      'synapsys',
      'lib',
      'matcher.js'
    );
    return require(matcherPath).safeRegex;
  } catch {
    return (pattern, flags = 'i') => {
      try {
        return new RegExp(pattern, flags);
      } catch {
        return null;
      }
    };
  }
}

const DEFAULT_PRIORITY = 50;

// Per-event handler arrays. Module-level state — callers that need isolation
// should `delete require.cache[require.resolve('./event-bus.js')]` and re-require.
const registry = Object.create(null);

/**
 * Compare two handler records for ordering.
 * Priority descending; sourceFile ascending lexical tiebreaker.
 * @param {{priority: number, sourceFile: string}} a
 * @param {{priority: number, sourceFile: string}} b
 * @returns {number}
 */
function compareHandlers(a, b) {
  if (a.priority !== b.priority) {
    return b.priority - a.priority;
  }
  return a.sourceFile < b.sourceFile ? -1 : a.sourceFile > b.sourceFile ? 1 : 0;
}

/**
 * Compile a handler `match` (string | RegExp) into `{ pattern, compiled }` once
 * at registration time so the dispatcher path stays compile-free (R1/G9 Task 8).
 * Invalid patterns throw — the caller (loader) is expected to log and skip the
 * extension so /work keeps running.
 *
 * @param {string|RegExp} match
 * @param {string} sourceFile  for diagnostics
 * @returns {{ pattern: string, compiled: RegExp }}
 */
function compileMatch(match, sourceFile) {
  const safeRegex = getSafeRegex();
  let pattern;
  let flags = 'i';
  if (match instanceof RegExp) {
    pattern = match.source;
    flags = match.flags || 'i';
  } else if (typeof match === 'string') {
    pattern = match;
  } else {
    throw new Error(
      `[event-bus] invalid match for ${sourceFile}: expected string or RegExp, got ${typeof match}`
    );
  }
  const compiled = safeRegex(pattern, flags);
  if (!compiled) {
    throw new Error(
      `[event-bus] invalid regex match "${pattern}" for ${sourceFile}: registration rejected`
    );
  }
  return { pattern, compiled };
}

/**
 * Register a handler against an event.
 * @param {{eventName: string, handler: Function, priority?: number, sourceFile: string, match?: RegExp|string}} entry
 */
function register(entry) {
  const { eventName, handler, sourceFile } = entry;
  const priority = typeof entry.priority === 'number' ? entry.priority : DEFAULT_PRIORITY;

  let match;
  if (entry.match !== undefined && entry.match !== null) {
    match = compileMatch(entry.match, sourceFile);
  }

  const record = {
    eventName,
    handler,
    priority,
    sourceFile,
    match,
  };

  if (!registry[eventName]) {
    registry[eventName] = [];
  }
  registry[eventName].push(record);
  registry[eventName].sort(compareHandlers);
}

/**
 * List handler records for an event in dispatch order.
 * @param {string} eventName
 * @returns {Array<object>}
 */
function listHandlers(eventName) {
  return registry[eventName] ? registry[eventName].slice() : [];
}

/**
 * Dispatch an event: await each handler in priority order; passthrough returns continue the chain.
 * @param {string} eventName
 * @param {object} payload
 * @param {object} ctx
 * @returns {Promise<void>}
 */
async function dispatch(eventName, payload, ctx) {
  const handlers = registry[eventName];
  if (!handlers || handlers.length === 0) {
    return;
  }
  for (const record of handlers) {
    try {
      await record.handler(payload, ctx);
    } catch (err) {
      // R6/G5: a throwing handler is caught and treated as passthrough so
      // subsequent handlers in the priority chain still run. The error is
      // logged via debug-log (if ctx carries tasksDir) AND stderr so visibility
      // matches the index.js error path described in spec §AD.
      logDispatchError(eventName, record.sourceFile, err, ctx);
    }
  }
}

/**
 * Dual-sink error log for handler-thrown errors during dispatch.
 * Writes to `<tasksDir>/debug.md` when `ctx.tasksDir` is available and always
 * emits a stderr warn so /work terminal output surfaces the failure.
 * Fail-open in both sinks — a logging failure must never crash the dispatcher.
 *
 * @param {string} eventName
 * @param {string} sourceFile
 * @param {Error} err
 * @param {{tasksDir?: string}} ctx
 */
function logDispatchError(eventName, sourceFile, err, ctx) {
  const message = err && err.message;
  const name = err && err.name;
  if (ctx && ctx.tasksDir) {
    try {
      const { createDebugLog } = require('../debug-log');
      createDebugLog(ctx.tasksDir).error('extension handler threw', {
        event: eventName,
        sourceFile,
        name: name || 'Error',
        message,
      });
    } catch {
      /* fail-open */
    }
  }
  try {
    process.stderr.write(
      `[work-extensions] handler error for ${eventName} (${sourceFile}): ${name || 'Error'}: ${message}\n`
    );
  } catch {
    /* fail-open */
  }
}

/**
 * Dispatch to a single specific handler record (already located via
 * listHandlers + match). Used by `fireAgentResponseMatched` to invoke ONLY
 * the handler whose pattern matched, instead of re-dispatching to every
 * handler for the event. Wraps the call in the same try/catch as `dispatch`.
 *
 * @param {{eventName: string, handler: Function, sourceFile: string}} record
 * @param {object} payload
 * @param {object} ctx
 * @returns {Promise<void>}
 */
async function dispatchToHandler(record, payload, ctx) {
  if (!record || typeof record.handler !== 'function') return;
  try {
    await record.handler(payload, ctx);
  } catch (err) {
    logDispatchError(record.eventName, record.sourceFile, err, ctx);
  }
}

module.exports = {
  register,
  dispatch,
  dispatchToHandler,
  listHandlers,
  DEFAULT_PRIORITY,
};
