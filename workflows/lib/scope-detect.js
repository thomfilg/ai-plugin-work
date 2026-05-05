'use strict';

/**
 * Well-known directory prefixes mapped to scope names.
 * Order matters: more specific prefixes must come first.
 * @type {Array<[string, string]>}
 */
const SCOPE_MAP = [
  ['workflows/lib/hooks/', 'hooks'],
  ['workflows/lib/', 'lib'],
  ['workflows/work/', 'work'],
  ['agents/', 'agents'],
  ['skills/', 'skills'],
  ['hooks/', 'hooks'],
];

/**
 * Prefixes that indicate monorepo package/app directories.
 * The segment immediately after the prefix is used as the scope.
 * @type {string[]}
 */
const MONO_PREFIXES = ['packages/', 'apps/'];

/**
 * Extract scope from a file path using the well-known scope map.
 * @param {string} filePath
 * @returns {string} scope or empty string
 */
function scopeFromMap(filePath) {
  for (const [prefix, scope] of SCOPE_MAP) {
    if (filePath.startsWith(prefix)) return scope;
  }
  return '';
}

/**
 * Extract scope from a monorepo-style path (packages/<name>/... or apps/<name>/...).
 * @param {string} filePath
 * @returns {string} package/app name or empty string
 */
function scopeFromMono(filePath) {
  for (const prefix of MONO_PREFIXES) {
    if (filePath.startsWith(prefix)) {
      const rest = filePath.slice(prefix.length);
      const seg = rest.split('/')[0];
      if (seg) return seg;
    }
  }
  return '';
}

/**
 * Detect conventional commit scope from an array of file paths.
 *
 * Heuristics (in order):
 *  1. Empty array → ''
 *  2. Monorepo paths (packages/<name>, apps/<name>) → <name> if unanimous
 *  3. Well-known directory map → scope if unanimous
 *  4. Root-level files or mixed scopes → ''
 *
 * @param {string[]} filePaths — paths from `git diff --name-only`
 * @returns {string} scope string, or '' when no single scope can be determined
 */
function detectScope(filePaths) {
  if (!filePaths || filePaths.length === 0) return '';

  /** @type {Set<string>} */
  const scopes = new Set();

  for (const fp of filePaths) {
    const normalized = fp.replace(/\\/g, '/');

    // Try monorepo detection first
    const mono = scopeFromMono(normalized);
    if (mono) {
      scopes.add(mono);
      continue;
    }

    // Try well-known scope map
    const mapped = scopeFromMap(normalized);
    if (mapped) {
      scopes.add(mapped);
      continue;
    }

    // Root-level file or unmapped directory — skip (neutral, doesn't affect scope)
    continue;
  }

  // Unanimous scope wins; mixed scopes → ''
  if (scopes.size === 1) {
    const [scope] = scopes;
    return scope;
  }

  return '';
}

module.exports = { detectScope };
