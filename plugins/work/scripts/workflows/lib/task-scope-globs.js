/**
 * task-scope-globs.js
 *
 * Glob + path predicates extracted from task-scope.js to keep that file
 * under the max-lines threshold. Pure utilities — no I/O, no state.
 */

'use strict';

const path = require('path');

/**
 * Returns true when a tasks.md scope/dep entry is an absolute path
 * (POSIX `/...` or Windows `C:\...`). Cross-task / scope entries must
 * always be repo-relative; absolute paths bypass the worktree envelope.
 *
 * @param {string} entry
 * @returns {boolean}
 */
function _isAbsolutePathEntry(entry) {
  if (typeof entry !== 'string' || !entry) return false;
  if (path.isAbsolute(entry)) return true;
  if (/^[A-Za-z]:[\\/]/.test(entry)) return true; // Windows drive
  return false;
}

/**
 * Compile a glob pattern to an anchored RegExp. Supports:
 *   - `**` → `.*` (cross-segment wildcard)
 *   - `*`  → `[^/]*` (within-segment wildcard)
 *   - `?`  → `[^/]` (single character within a segment)
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$(){}[]|\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Try to match `candidate` against a single glob entry. Returns true on a
 * match, false otherwise (including malformed patterns).
 *
 * @param {string} norm normalised candidate
 * @param {string} raw scope entry (possibly with leading `./` or trailing `/`)
 * @returns {boolean}
 */
function _matchOne(norm, raw) {
  if (typeof raw !== 'string' || !raw) return false;
  let glob = raw.replace(/^\.\//, '');
  if (glob === norm) return true;
  if (glob.endsWith('/')) glob += '**';
  try {
    return globToRegExp(glob).test(norm);
  } catch {
    return false;
  }
}

/**
 * Check whether a candidate file path is covered by any of the task's
 * `Files in scope` glob patterns.
 *
 * @param {string} candidate
 * @param {string[]} scopeGlobs
 * @returns {boolean}
 */
function fileMatchesScope(candidate, scopeGlobs) {
  if (!candidate || !Array.isArray(scopeGlobs) || scopeGlobs.length === 0) return false;
  const norm = String(candidate).replace(/^\.\//, '');
  for (const raw of scopeGlobs) {
    if (_matchOne(norm, raw)) return true;
  }
  return false;
}

/**
 * Recognise a test file by extension.
 */
const TEST_FILE_EXT_RE = /\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/;

/**
 * Decide whether a test file path follows the project's integration-test
 * naming convention.
 *
 * @param {string} candidate
 * @returns {boolean}
 */
function isIntegrationTestPath(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  if (!TEST_FILE_EXT_RE.test(candidate)) return false;
  if (/\.integration\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(candidate)) return true;
  if (/(?:^|\/)integration\//.test(candidate)) return true;
  return false;
}

/**
 * Decide whether a test file path follows the project's e2e naming convention.
 */
function isE2eTestPath(candidate) {
  if (typeof candidate !== 'string' || !candidate) return false;
  if (!TEST_FILE_EXT_RE.test(candidate)) return false;
  if (/\.e2e\.(?:test|spec)\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(candidate)) return true;
  if (/(?:^|\/)e2e\//.test(candidate)) return true;
  return false;
}

module.exports = {
  _isAbsolutePathEntry,
  globToRegExp,
  fileMatchesScope,
  TEST_FILE_EXT_RE,
  isIntegrationTestPath,
  isE2eTestPath,
};
