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

/** Decide whether the Test Command targets the integration runner. */
function usesIntegrationRunner(testCommand) {
  return typeof testCommand === 'string' && /\$TEST_INTEGRATION_COMMAND\b/.test(testCommand);
}

/** Decide whether the Test Command targets the unit runner. */
function usesUnitRunner(testCommand) {
  return typeof testCommand === 'string' && /\$TEST_UNIT_COMMAND\b/.test(testCommand);
}

/** Decide whether the Test Command targets the e2e runner. */
function usesE2eRunner(testCommand) {
  return typeof testCommand === 'string' && /\$TEST_E2E_COMMAND\b/.test(testCommand);
}

/**
 * Decide whether the Test Command is a recognised test-runner invocation.
 */
function usesRecognisedRunner(testCommand) {
  return (
    usesUnitRunner(testCommand) || usesIntegrationRunner(testCommand) || usesE2eRunner(testCommand)
  );
}

/**
 * Detect Test Commands that pretend to be a test gate but actually run
 * something that never asserts behavior. Returns a short category name when
 * matched, null otherwise.
 */
function detectNonTestCommand(testCommand) {
  if (typeof testCommand !== 'string' || !testCommand.trim()) return null;
  if (usesRecognisedRunner(testCommand)) return null;
  const lower = testCommand.toLowerCase();
  if (
    /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:test|vitest|jest|playwright|cypress|pw\s+test)\b/.test(
      lower
    )
  ) {
    return null;
  }
  if (
    /\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?typecheck\b|\btsc\b(?!.*-p\s+tsconfig\.test)/.test(lower)
  ) {
    return 'typecheck-only';
  }
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?(?:lint|format|prettier|biome|eslint)\b/.test(lower)) {
    return 'lint-only';
  }
  if (/\b(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?build\b/.test(lower)) {
    return 'build-only';
  }
  if (/^\s*(?:true|:|exit\s+0)\s*;?\s*$/.test(testCommand)) {
    return 'noop';
  }
  return null;
}

/**
 * Extract the CHANGED_FILES list from a task's `### Test Command`. Returns
 * an empty array if the command doesn't follow the canonical
 * `CHANGED_FILES="<list>" eval "$TEST_*_COMMAND"` form.
 *
 * @param {string|null|undefined} testCommand
 * @returns {string[]}
 */
function extractChangedFilesFromTestCommand(testCommand) {
  if (typeof testCommand !== 'string' || !testCommand) return [];
  const m = testCommand.match(/CHANGED_FILES\s*=\s*(['"])([\s\S]*?)\1/);
  if (!m) return [];
  return m[2].split(/\s+/).filter(Boolean);
}

/**
 * Walk every `eval "$TEST_*_COMMAND"` occurrence in a Test Command and pair
 * it with the nearest preceding `CHANGED_FILES=...` assignment in the SAME
 * segment.
 *
 * @param {string|null|undefined} testCommand
 * @returns {Array<{ eval:string, changedFiles:string|null, offset:number }>}
 */
function extractEvalScopePairs(testCommand) {
  if (typeof testCommand !== 'string' || !testCommand) return [];
  const flat = testCommand.replace(/\\\n/g, ' ');
  const segments = _splitSegments(flat);

  const evalRe = /eval\s+(['"])\$TEST_[A-Z0-9_]+_COMMAND\1/g;
  const cfRe = /CHANGED_FILES\s*=\s*(['"])([\s\S]*?)\1/g;
  const pairs = [];
  for (const seg of segments) {
    const cfMatches = _collectMatches(cfRe, seg.text, (cf) => ({ value: cf[2], index: cf.index }));
    const evalMatches = _collectMatches(evalRe, seg.text, (em) => ({
      raw: em[0],
      index: em.index,
    }));
    for (const em of evalMatches) {
      let nearest = null;
      for (const c of cfMatches) {
        if (c.index < em.index) nearest = c;
      }
      pairs.push({
        eval: em.raw.match(/\$TEST_[A-Z0-9_]+_COMMAND/)[0],
        changedFiles: nearest ? nearest.value : null,
        offset: seg.offset + em.index,
      });
    }
  }
  return pairs;
}

function _splitSegments(flat) {
  const segments = [];
  let cursor = 0;
  const sepRe = /&&|;/g;
  let m;
  while ((m = sepRe.exec(flat)) !== null) {
    segments.push({ text: flat.slice(cursor, m.index), offset: cursor });
    cursor = m.index + m[0].length;
  }
  segments.push({ text: flat.slice(cursor), offset: cursor });
  return segments;
}

function _collectMatches(re, text, projector) {
  const out = [];
  let m;
  re.lastIndex = 0;
  while ((m = re.exec(text)) !== null) out.push(projector(m));
  return out;
}

module.exports = {
  _isAbsolutePathEntry,
  globToRegExp,
  fileMatchesScope,
  TEST_FILE_EXT_RE,
  isIntegrationTestPath,
  isE2eTestPath,
  usesIntegrationRunner,
  usesUnitRunner,
  usesE2eRunner,
  usesRecognisedRunner,
  detectNonTestCommand,
  extractChangedFilesFromTestCommand,
  extractEvalScopePairs,
};
