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

module.exports = { validateTask, validateAll, unionFilesInScope, findTask };
