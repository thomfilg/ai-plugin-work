'use strict';

/**
 * detect.js — new-variable detection with a persistent hash cache (GH-70).
 *
 * The cache lives under ~/.claude/.cache/ and stores, per project root and
 * per plugin, the schema hash last acknowledged by the user plus the vars
 * they explicitly configured or skipped. The fast path is one hash compare:
 * when the stored hash matches the current schema, detection is O(1) and
 * silent. Only the configure flow updates the cache (a detection hook never
 * self-acknowledges, so the nudge persists until the user acts).
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { schemaHash } = require('./schema');

const CACHE_VERSION = 1;

function loadCache(cachePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (parsed && parsed.version === CACHE_VERSION && parsed.projects) return parsed;
  } catch {
    /* first run or corrupt cache — start fresh */
  }
  return { version: CACHE_VERSION, projects: {} };
}

/** Atomic write (tmp + rename) so concurrent sessions never see torn JSON. */
function saveCache(cachePath, cache) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cache, null, 2)}\n`);
  fs.renameSync(tmp, cachePath);
}

/** Stable per-project key: git toplevel when available, else cwd. */
function projectKey(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    return path.resolve(cwd);
  }
}

function cacheEntry(cache, projectRoot, plugin) {
  return (cache.projects[projectRoot] || {})[plugin] || null;
}

/**
 * Compare a plugin schema against the cache + currently-visible values.
 *
 * Returns:
 *   { changed: false }                                    — fast path
 *   { changed: true, firstRun, hash, missing: [names] }   — action needed
 *
 * `missing` = declared, non-advanced vars that are neither set in any env
 * source nor previously acknowledged. Advanced vars never nag.
 */
function detect({ schema, cachePath, projectRoot, values }) {
  const hash = schemaHash(schema);
  const cache = loadCache(cachePath);
  const entry = cacheEntry(cache, projectRoot, schema.plugin);
  const acknowledgedVars = entry ? entry.acknowledgedVars || [] : [];
  if (entry && entry.schemaHash === hash) return { changed: false, hash, acknowledgedVars };

  const acknowledged = new Set(acknowledgedVars);
  const missing = Object.entries(schema.vars)
    .filter(([name, def]) => !def.advanced && !(name in values) && !acknowledged.has(name))
    .map(([name]) => name);
  return { changed: true, firstRun: !entry, hash, missing, acknowledgedVars };
}

/**
 * Record a completed configure pass: store the schema hash and the union of
 * previously + newly acknowledged vars for this project/plugin pair.
 */
function markConfigured({ cachePath, projectRoot, plugin, hash, acknowledgedVars = [] }) {
  const cache = loadCache(cachePath);
  const project = cache.projects[projectRoot] || (cache.projects[projectRoot] = {});
  const prior = project[plugin] ? project[plugin].acknowledgedVars || [] : [];
  project[plugin] = {
    schemaHash: hash,
    lastChecked: new Date().toISOString(),
    acknowledgedVars: [...new Set([...prior, ...acknowledgedVars])],
  };
  saveCache(cachePath, cache);
}

module.exports = { loadCache, saveCache, projectKey, detect, markConfigured };
