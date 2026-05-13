/**
 * related-tickets.js
 *
 * Schema, reader, writer, and validator for `tasks/<ticket>/related-tickets.json`.
 *
 * This manifest documents the parent, siblings, blockedBy, dependsOn, and
 * relatedTo tickets discovered at brief-time. Brief / spec / tasks agents
 * read it as their source of sibling-ownership facts so they don't absorb
 * sibling-owned surfaces into the current ticket's scope.
 *
 * The Node side does NOT fetch tickets itself — the brief-writer agent
 * fetches via MCP / `gh` and writes the file. This module only provides
 * the path helper, the schema validator, and a stale-check.
 */

'use strict';

const ARTIFACT_FILENAME = 'related-tickets.json';

/**
 * Absolute path to the manifest for a given tasksDir.
 * @param {string} tasksDir
 * @param {{ join: Function }} pathMod
 * @returns {string}
 */
function manifestPath(tasksDir, pathMod) {
  return pathMod.join(tasksDir, ARTIFACT_FILENAME);
}

/**
 * Read and parse the manifest. Returns null on missing/unreadable/invalid JSON.
 * Does not throw.
 */
function read(tasksDir, deps) {
  const { fs, path: pathMod } = deps;
  const file = manifestPath(tasksDir, pathMod);
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Validate a parsed manifest object. Returns { valid, errors: string[] }.
 * Shape (all link arrays are required, may be empty):
 *   {
 *     self: { id, title?, status? },
 *     parent: { id, title?, status?, scope? } | null,
 *     siblings: Array<{ id, title?, status?, scope?, prNumber?, surfaces?: string[] }>,
 *     blockedBy: Array<{ id, title?, status?, scope?, prNumber? }>,
 *     dependsOn: Array<{ id, title?, status?, scope?, prNumber? }>,
 *     relatedTo: Array<{ id, title?, status?, scope?, prNumber? }>,
 *     fetchedAt: ISO-8601 string
 *   }
 *
 * `scope` is a one-to-three-sentence agent-authored distillation of each
 * linked ticket's description, naming the files/endpoints/schemas that
 * ticket owns. Used by the brief-writer at Gate A when `surfaces` is empty
 * (no merged PR yet) to decide sibling ownership without asking the user.
 */
function validate(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, errors: ['manifest is not an object'] };
  }
  if (!manifest.self || typeof manifest.self.id !== 'string' || !manifest.self.id) {
    errors.push('self.id is required (string)');
  }
  if (manifest.parent !== null && manifest.parent !== undefined) {
    if (typeof manifest.parent !== 'object' || typeof manifest.parent.id !== 'string') {
      errors.push('parent must be null or { id: string, ... }');
    }
  }
  for (const key of ['siblings', 'blockedBy', 'dependsOn', 'relatedTo']) {
    if (!Array.isArray(manifest[key])) {
      errors.push(`${key} must be an array (may be empty)`);
      continue;
    }
    manifest[key].forEach((entry, i) => {
      if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string' || !entry.id) {
        errors.push(`${key}[${i}].id is required (string)`);
      }
    });
  }
  if (typeof manifest.fetchedAt !== 'string' || Number.isNaN(Date.parse(manifest.fetchedAt))) {
    errors.push('fetchedAt must be an ISO-8601 string');
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Read + validate. Returns { manifest, valid, errors, missing }.
 *   missing = true when the file doesn't exist on disk.
 */
function readAndValidate(tasksDir, deps) {
  const { fs, path: pathMod } = deps;
  const file = manifestPath(tasksDir, pathMod);
  if (!fs.existsSync(file)) {
    return {
      manifest: null,
      valid: false,
      errors: ['manifest file does not exist'],
      missing: true,
    };
  }
  const manifest = read(tasksDir, deps);
  if (manifest === null) {
    return {
      manifest: null,
      valid: false,
      errors: ['manifest file is not valid JSON'],
      missing: false,
    };
  }
  const { valid, errors } = validate(manifest);
  return { manifest, valid, errors, missing: false };
}

/**
 * @param {object} manifest
 * @param {string|Date} runStartedAt - The /work2 run start time (ISO string or Date)
 * @returns {boolean} true when fetchedAt is older than runStartedAt
 */
function isStale(manifest, runStartedAt) {
  if (!manifest || typeof manifest.fetchedAt !== 'string') return true;
  const fetched = Date.parse(manifest.fetchedAt);
  const start = runStartedAt instanceof Date ? runStartedAt.getTime() : Date.parse(runStartedAt);
  if (Number.isNaN(fetched) || Number.isNaN(start)) return true;
  return fetched < start;
}

/**
 * Flatten all sibling-owned IDs (parent + siblings + blockedBy + dependsOn + relatedTo)
 * for quick membership checks. Returns an array of unique ticket IDs (strings).
 */
function siblingIds(manifest) {
  if (!manifest) return [];
  const ids = new Set();
  if (manifest.parent && typeof manifest.parent.id === 'string') ids.add(manifest.parent.id);
  for (const key of ['siblings', 'blockedBy', 'dependsOn', 'relatedTo']) {
    if (Array.isArray(manifest[key])) {
      for (const e of manifest[key]) {
        if (e && typeof e.id === 'string') ids.add(e.id);
      }
    }
  }
  return Array.from(ids);
}

/**
 * Union of all `surfaces` arrays declared on siblings + parent. Used by
 * downstream gates to detect when a brief / spec / tasks touches a path
 * owned by a sibling ticket. Surfaces are file paths (or globs) as written
 * by the brief-writer agent based on each sibling's merged PR diff.
 */
function siblingSurfaces(manifest) {
  if (!manifest) return [];
  const out = new Set();
  const collect = (entry) => {
    if (entry && Array.isArray(entry.surfaces)) {
      for (const s of entry.surfaces) {
        if (typeof s === 'string' && s) out.add(s);
      }
    }
  };
  collect(manifest.parent);
  if (Array.isArray(manifest.siblings)) manifest.siblings.forEach(collect);
  if (Array.isArray(manifest.blockedBy)) manifest.blockedBy.forEach(collect);
  if (Array.isArray(manifest.dependsOn)) manifest.dependsOn.forEach(collect);
  if (Array.isArray(manifest.relatedTo)) manifest.relatedTo.forEach(collect);
  return Array.from(out);
}

module.exports = {
  ARTIFACT_FILENAME,
  manifestPath,
  read,
  readAndValidate,
  validate,
  isStale,
  siblingIds,
  siblingSurfaces,
};
