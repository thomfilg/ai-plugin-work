/**
 * task-scope.js
 *
 * Gate C — pure validators for the per-task `Files in scope` and
 * `Files explicitly out of scope` declarations. Used by the implement-time
 * gate to refuse dispatch when scope sections are missing or empty, and
 * by Gate D's hook to compute the active envelope.
 *
 * The parser lives in `scripts/workflows/work/task-parser.js`. This file
 * only validates the already-parsed objects.
 */

'use strict';

/**
 * Validate one task object's scope sections.
 *
 * @param {{ num:number, filesInScope?:string[], filesOutOfScope?:string[] }} task
 * @returns {string[]} validation error messages (empty when valid)
 */
function validateTask(task) {
  const errors = [];
  if (!task || typeof task !== 'object') {
    return ['task must be an object'];
  }
  const label = `Task ${task.num ?? '?'}`;

  // Legacy fallback: tasks written before Gate C may carry `### Suggested Scope`
  // instead of `### Files in scope`. Accept that as evidence of scope intent
  // and ONLY error when BOTH are missing/empty. New tasks SHOULD use
  // `### Files in scope`; the warning surfaces via downstream check-step
  // tooling (Gate E), not as a hard implement-step block.
  const hasInScope = Array.isArray(task.filesInScope) && task.filesInScope.length > 0;
  const hasLegacyScope =
    typeof task.suggestedScope === 'string' && task.suggestedScope.trim().length > 0;
  if (!hasInScope && !hasLegacyScope) {
    errors.push(
      `${label} is missing both \`### Files in scope\` AND \`### Suggested Scope\` (need at least one)`
    );
  }
  // `### Files explicitly out of scope` is forward-looking and not required
  // for legacy tasks. New tasks (those with `### Files in scope`) SHOULD
  // include it; tolerate absence here and surface in Gate E review.
  if (task.filesOutOfScope !== undefined && !Array.isArray(task.filesOutOfScope)) {
    errors.push(`${label} has malformed \`### Files explicitly out of scope\` section`);
  }
  return errors;
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
  // Match CHANGED_FILES="..." or CHANGED_FILES='...'. Tolerant of leading
  // whitespace and `&&`/`;` chains — we only need the FIRST assignment to
  // judge what the gate will execute against.
  const m = testCommand.match(/CHANGED_FILES\s*=\s*(['"])([\s\S]*?)\1/);
  if (!m) return [];
  return m[2].split(/\s+/).filter(Boolean);
}

/**
 * Check whether a candidate file path is covered by any of the task's
 * `Files in scope` glob patterns. Performs a simple prefix/segment match
 * sufficient for tasks.md authoring (full glob matching happens at
 * Gate D runtime via micromatch).
 *
 * Returns true when the candidate equals a scope entry, sits under one
 * (treating `**` as a wildcard), or matches the directory prefix of a
 * scope entry that ends with a glob.
 *
 * @param {string} candidate
 * @param {string[]} scopeGlobs
 * @returns {boolean}
 */
function fileMatchesScope(candidate, scopeGlobs) {
  if (!candidate || !Array.isArray(scopeGlobs) || scopeGlobs.length === 0) return false;
  const norm = String(candidate).replace(/^\.\//, '');
  for (const raw of scopeGlobs) {
    if (typeof raw !== 'string' || !raw) continue;
    const glob = raw.replace(/^\.\//, '');
    if (glob === norm) return true;
    // `lib/foo/**` or `lib/foo/**/*.ts` → match anything under lib/foo/
    const starIdx = glob.indexOf('*');
    if (starIdx > 0) {
      const prefix = glob.slice(0, starIdx);
      if (norm.startsWith(prefix)) return true;
    } else if (glob.endsWith('/')) {
      if (norm.startsWith(glob)) return true;
    }
  }
  return false;
}

/**
 * Verify the task's Test Command CHANGED_FILES list is fully covered by
 * this task's `### Files in scope`. When a CHANGED_FILES path is owned
 * by another task, the test will execute through that other task's code
 * — and the gate cannot pass until that sibling is also complete. That
 * is the ECHO-4637-class deadlock.
 *
 * @param {object} task
 * @returns {string[]} validation errors
 */
function validateTaskTestScope(task) {
  const errors = [];
  if (!task || typeof task !== 'object') return errors;
  const changed = extractChangedFilesFromTestCommand(task.testCommand);
  if (changed.length === 0) return errors;
  const scope =
    Array.isArray(task.filesInScope) && task.filesInScope.length > 0 ? task.filesInScope : null;
  if (!scope) return errors; // already reported by validateTask
  const offenders = changed.filter((p) => !fileMatchesScope(p, scope));
  if (offenders.length > 0) {
    errors.push(
      `Task ${task.num ?? '?'} \`### Test Command\` references files not in its \`### Files in scope\`: ` +
        offenders.map((p) => `"${p}"`).join(', ') +
        '. The gate will execute the test against code owned by sibling tasks, which cannot pass until ' +
        'those siblings are also complete (deadlock). Fix by either: (a) narrowing the Test Command to a ' +
        "unit test of files this task actually ships, or (b) widening this task's Files in scope to include " +
        'the referenced files (only if this task should own them).'
    );
  }
  return errors;
}

/**
 * Validate every task and return a flat error list.
 *
 * @param {Array<object>|null|undefined} tasks
 * @returns {{ valid:boolean, errors:string[] }}
 */
function validateAll(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return { valid: false, errors: ['no tasks parsed from tasks.md'] };
  }
  const errors = [];
  for (const t of tasks) {
    errors.push(...validateTask(t));
    errors.push(...validateTaskTestScope(t));
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Union of `filesInScope` across the supplied tasks. Used by Gate E.
 *
 * @param {Array<object>} tasks
 * @returns {string[]}
 */
function unionFilesInScope(tasks) {
  const out = new Set();
  if (!Array.isArray(tasks)) return [];
  for (const t of tasks) {
    if (Array.isArray(t?.filesInScope)) {
      for (const p of t.filesInScope) {
        if (typeof p === 'string' && p) out.add(p);
      }
    }
  }
  return Array.from(out);
}

/**
 * Find the task with the matching task number, or null.
 *
 * @param {Array<object>} tasks
 * @param {number} taskNum
 * @returns {object|null}
 */
function findTask(tasks, taskNum) {
  if (!Array.isArray(tasks) || typeof taskNum !== 'number') return null;
  return tasks.find((t) => t && t.num === taskNum) || null;
}

module.exports = {
  validateTask,
  validateTaskTestScope,
  validateAll,
  unionFilesInScope,
  findTask,
  extractChangedFilesFromTestCommand,
  fileMatchesScope,
};
