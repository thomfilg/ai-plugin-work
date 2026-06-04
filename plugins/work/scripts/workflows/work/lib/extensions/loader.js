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
 *
 * Session scoping: callers (index.js / hook entry points) gate on
 * `findActiveMarker` from `../marker` before invoking `loadExtensions`, so
 * this module stays pure (no I/O outside the supplied repoRoot/tasksDir) and
 * relies on the marker check upstream to scope extension loading to an active
 * /work session.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { createDebugLog } = require('../debug-log');
// marker.js — referenced by callers (index.js / hooks) via findActiveMarker
// to gate loadExtensions on an active /work session; loader itself is pure.
const _marker = require('../marker'); // eslint-disable-line no-unused-vars

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
    // R8 backward compatibility: repos without `.claude/work-extensions/`
    // MUST NOT see any stderr warning. Debug-log is kept (only visible when
    // tasksDir is opened) but stderr is silenced for the common no-extensions
    // case so /work behaves identically to today for non-extension repos.
    try {
      log.error('no extensions directory; skipping', { dir: extDir });
    } catch {
      /* fail-open */
    }
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
    const full = path.join(extDir, name);
    const ext = path.extname(name).toLowerCase();

    if (ext === '.ts') {
      const msg = `Phase 1 supports .js only — skipping ${name}`;
      warn(log, full, msg);
      status.push({ file: full, events: [], loaded: false, error: msg });
      continue;
    }

    if (ext !== '.js') {
      continue;
    }

    // Path-traversal hardening: ensure realpath sits under realExtDir.
    let realFile;
    try {
      realFile = fs.realpathSync(full);
    } catch (err) {
      warn(log, full, `failed to resolve realpath: ${err.message}`);
      status.push({ file: full, events: [], loaded: false, error: err.message });
      continue;
    }

    const rel = path.relative(realExtDir, realFile);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      const msg = `path traversal rejected — realpath outside extensions dir: ${realFile}`;
      warn(log, full, msg);
      status.push({ file: full, events: [], loaded: false, error: msg });
      continue;
    }

    let mod;
    try {
      // Always re-require to avoid stale module cache across tests / reloads.
      delete require.cache[realFile];
      mod = require(realFile);
    } catch (err) {
      const msg = `failed to require extension: ${err.message}`;
      warn(log, full, msg);
      status.push({ file: full, events: [], loaded: false, error: err.message });
      continue;
    }

    const validationError = validateExport(mod);
    if (validationError) {
      warn(log, full, validationError);
      status.push({ file: full, events: [], loaded: false, error: validationError });
      continue;
    }

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
      const msg = `failed to register extension: ${err.message}`;
      warn(log, full, msg);
      status.push({ file: full, events: mod.events || [], loaded: false, error: err.message });
      continue;
    }

    status.push({ file: full, events: mod.events.slice(), loaded: true });
  }

  return status;
}

module.exports = {
  loadExtensions,
  validateExport,
};
