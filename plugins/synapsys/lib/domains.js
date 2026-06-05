'use strict';

/**
 * Domain registry parser for synapsys (GH-513 Task 2).
 *
 * Reads `~/.claude/synapsys/DOMAINS.md` and falls back to a bundled file when
 * the user file is absent. Returns a `{ roots: Map<string, { leaves: Map<string,
 * { signal_prompt: RegExp[], signal_pretool: RegExp[] }> }> }` shape.
 *
 * Caching: mtime-keyed in-memory cache; second call with unchanged mtime
 * returns the same object by reference.
 *
 * Fail-open: any I/O error, missing file (both locations), malformed body, or
 * invalid regex is swallowed → empty registry / dropped pattern, never throws.
 *
 * Performance budget: parse + cache hit kept well under the <5ms classifier
 * budget; the cache hit path performs a single `fs.statSync` and returns.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { safeRegex } = require('./matcher');

const DEFAULT_BUNDLED_PATH = path.join(__dirname, 'DOMAINS.md');

/** @type {{ path: string, mtimeMs: number, registry: object } | null} */
let cache = null;

/**
 * Reset the in-memory cache. Exported for tests.
 */
function _resetDomainCache() {
  cache = null;
}

function emptyRegistry() {
  return { roots: new Map() };
}

function userRegistryPath(home) {
  return path.join(home, '.claude', 'synapsys', 'DOMAINS.md');
}

/**
 * Resolve the file path to read. Prefers user file; falls back to bundled.
 * Returns null when neither exists.
 */
function resolveRegistryPath(home, bundledPath) {
  const userPath = userRegistryPath(home);
  try {
    if (fs.existsSync(userPath)) return userPath;
  } catch {
    // fall through to bundled
  }
  try {
    if (bundledPath && fs.existsSync(bundledPath)) return bundledPath;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Line-scan parser (no full YAML). Format:
 *
 *   root: <name>
 *     leaf: <name>
 *       signal_prompt: <pattern>
 *       signal_pretool: <pattern>
 *
 * Invalid regex sources are dropped via `safeRegex`. Unrecognized lines are
 * ignored.
 */
function parseRegistryBody(body) {
  const registry = emptyRegistry();
  let currentRoot = null;
  let currentLeaf = null;

  const lines = String(body).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.trim().startsWith('#')) continue;

    const rootMatch = line.match(/^root:\s*(\S+)\s*$/);
    if (rootMatch) {
      const name = rootMatch[1];
      currentRoot = { leaves: new Map() };
      registry.roots.set(name, currentRoot);
      currentLeaf = null;
      continue;
    }

    const leafMatch = line.match(/^\s+leaf:\s*(\S+)\s*$/);
    if (leafMatch && currentRoot) {
      const name = leafMatch[1];
      currentLeaf = { signal_prompt: [], signal_pretool: [] };
      currentRoot.leaves.set(name, currentLeaf);
      continue;
    }

    const signalMatch = line.match(/^\s+(signal_prompt|signal_pretool):\s*(.+?)\s*$/);
    if (signalMatch && currentLeaf) {
      const [, kind, pattern] = signalMatch;
      const re = safeRegex(pattern);
      if (re) currentLeaf[kind].push(re);
      continue;
    }
    // anything else: ignore (fail-open on malformed lines)
  }

  return registry;
}

/**
 * Load the domain registry, honoring user-file precedence and mtime cache.
 *
 * @param {object} [opts]
 * @param {string} [opts.home]          Home directory (default: os.homedir())
 * @param {string} [opts.bundledPath]   Path to bundled fallback (default: ./DOMAINS.md)
 * @returns {{ roots: Map<string, { leaves: Map<string, { signal_prompt: RegExp[], signal_pretool: RegExp[] }> }> }}
 */
function statMtime(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function readFileText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

function loadRegistryUncached(home, bundledPath) {
  const filePath = resolveRegistryPath(home, bundledPath);
  if (!filePath) return emptyRegistry();

  const mtimeMs = statMtime(filePath);
  if (mtimeMs === null) return emptyRegistry();

  if (cache && cache.path === filePath && cache.mtimeMs === mtimeMs) {
    return cache.registry;
  }

  const body = readFileText(filePath);
  if (body === null) return emptyRegistry();

  const registry = parseRegistryBody(body);
  cache = { path: filePath, mtimeMs, registry };
  return registry;
}

function loadDomainRegistry(opts = {}) {
  // SYNAPSYS_HOME overrides the user's home so the dispatcher reads from
  // the same root as the synapsys-status CLI. Caller-supplied opts.home
  // still wins (used by tests).
  const home = opts.home || process.env.SYNAPSYS_HOME || process.env.HOME || os.homedir();
  const bundledPath = opts.bundledPath || DEFAULT_BUNDLED_PATH;
  try {
    return loadRegistryUncached(home, bundledPath);
  } catch {
    return emptyRegistry();
  }
}

module.exports = {
  loadDomainRegistry,
  _resetDomainCache,
};
