/**
 * loader.js — discovers, validates, and registers /work extension modules.
 *
 * Responsibilities (Task 3 / R3, R6, R8, G1, G2, G4, G8):
 *   - Discover `.js` files under `<repoRoot>/.claude/work-extensions/`.
 *   - Skip `.ts` files in Phase 1 with a warning (G8).
 *   - Validate `{events, handler, priority?}` export shape.
 *   - Reject files whose realpath escapes the extensions directory (security).
 *   - Isolate require()-time errors per file so one broken extension does not
 *     crash /work (G4, R6).
 *   - Register valid extensions against the supplied event bus.
 *
 * Errors are logged via `createDebugLog(tasksDir).error(...)` and surfaced to
 * stderr at warn level.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createDebugLog } = require('../debug-log');

const EXTENSIONS_REL = path.join('.claude', 'work-extensions');

/**
 * Validate a loaded extension module shape.
 * @param {unknown} mod
 * @returns {string|null} error message, or null if valid
 */
function validateExport(mod) {
  if (!mod || typeof mod !== 'object') {
    return 'extension export must be an object with {events, handler}';
  }
  if (!Array.isArray(mod.events) || mod.events.length === 0) {
    return 'extension export missing required `events` array';
  }
  if (typeof mod.handler !== 'function') {
    return 'extension export missing required `handler` function';
  }
  return null;
}

function warn(log, file, message) {
  try {
    log.error(message, { file });
  } catch {
    /* fail-open */
  }
  try {
    process.stderr.write(`[work-extensions] ${file}: ${message}\n`);
  } catch {
    /* fail-open */
  }
}

function logNoExtDir(log, extDir) {
  try {
    log.error('no extensions directory; skipping', { dir: extDir });
  } catch {
    /* fail-open */
  }
  // Also emit informationally to stderr so callers without a debug log see it.
  try {
    process.stderr.write(`[work-extensions] no extensions directory; skipping (${extDir})\n`);
  } catch {
    /* fail-open */
  }
}

/**
 * Classify a directory entry by extension.
 * @returns {{skip: true}|{entry: object}|{ok: true}}
 *   `skip` → ignore silently; `entry` → a terminal status row; `ok` → a .js
 *   candidate to load.
 */
function classifyEntry(name, full, log) {
  const ext = path.extname(name).toLowerCase();
  if (ext === '.ts') {
    const msg = `Phase 1 supports .js only — skipping ${name}`;
    warn(log, full, msg);
    return { entry: { file: full, events: [], loaded: false, error: msg } };
  }
  if (ext !== '.js') return { skip: true };
  return { ok: true };
}

/**
 * Path-traversal hardening: resolve realpath and confirm it stays under the
 * extensions directory.
 * @returns {{realFile: string}|{entry: object}}
 */
function guardRealpath(full, realExtDir, log) {
  let realFile;
  try {
    realFile = fs.realpathSync(full);
  } catch (err) {
    warn(log, full, `failed to resolve realpath: ${err.message}`);
    return { entry: { file: full, events: [], loaded: false, error: err.message } };
  }
  const rel = path.relative(realExtDir, realFile);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const msg = `path traversal rejected — realpath outside extensions dir: ${realFile}`;
    warn(log, full, msg);
    return { entry: { file: full, events: [], loaded: false, error: msg } };
  }
  return { realFile };
}

/**
 * Require an extension module fresh (bypassing the module cache).
 * @returns {{mod: unknown}|{entry: object}}
 */
function requireExtension(realFile, full, log) {
  try {
    // Always re-require to avoid stale module cache across tests / reloads.
    delete require.cache[realFile];
    return { mod: require(realFile) };
  } catch (err) {
    warn(log, full, `failed to require extension: ${err.message}`);
    return { entry: { file: full, events: [], loaded: false, error: err.message } };
  }
}

/**
 * Register a validated extension's handler against the bus for each of its
 * events.
 * @returns {object} a terminal status row (success or error)
 */
function registerExtension(bus, mod, full, log) {
  try {
    for (const eventName of mod.events) {
      bus.register({
        eventName,
        handler: mod.handler,
        priority: mod.priority,
        sourceFile: full,
        match: mod.match,
      });
    }
  } catch (err) {
    warn(log, full, `failed to register extension: ${err.message}`);
    return { file: full, events: mod.events || [], loaded: false, error: err.message };
  }
  return { file: full, events: mod.events.slice(), loaded: true };
}

/**
 * Load a single directory entry into a status row.
 * @returns {object|null} a status row, or null when the entry is ignored.
 */
function loadEntry(name, extDir, realExtDir, bus, log) {
  const full = path.join(extDir, name);
  const cls = classifyEntry(name, full, log);
  if (cls.skip) return null;
  if (cls.entry) return cls.entry;

  const guarded = guardRealpath(full, realExtDir, log);
  if (guarded.entry) return guarded.entry;

  const required = requireExtension(guarded.realFile, full, log);
  if (required.entry) return required.entry;

  const validationError = validateExport(required.mod);
  if (validationError) {
    warn(log, full, validationError);
    return { file: full, events: [], loaded: false, error: validationError };
  }

  return registerExtension(bus, required.mod, full, log);
}

/**
 * Discover and load extensions from `<repoRoot>/.claude/work-extensions/`.
 *
 * @param {{repoRoot: string, tasksDir: string, bus: {register: Function}}} opts
 * @returns {Array<{file: string, events: string[], loaded: boolean, error?: string}>}
 */
function loadExtensions(opts) {
  const { repoRoot, tasksDir, bus } = opts || {};
  const log = createDebugLog(tasksDir);
  const status = [];

  const extDir = path.join(repoRoot, EXTENSIONS_REL);

  if (!fs.existsSync(extDir)) {
    logNoExtDir(log, extDir);
    return status;
  }

  let realExtDir;
  try {
    realExtDir = fs.realpathSync(extDir);
  } catch (err) {
    warn(log, extDir, `failed to resolve realpath: ${err.message}`);
    return status;
  }

  let entries;
  try {
    entries = fs.readdirSync(extDir);
  } catch (err) {
    warn(log, extDir, `failed to read extensions directory: ${err.message}`);
    return status;
  }

  for (const name of entries) {
    const entry = loadEntry(name, extDir, realExtDir, bus, log);
    if (entry) status.push(entry);
  }

  return status;
}

module.exports = {
  loadExtensions,
  validateExport,
};
