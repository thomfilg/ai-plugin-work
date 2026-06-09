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
 *
 * Implementation split across:
 *   - `task-scope-globs.js`       — pure path/glob/runner utilities
 *   - `task-scope-validators.js`  — per-rule validation functions
 *
 * This file preserves the public surface (`module.exports`) so external
 * consumers (`task-next.js`, `implement-gate.js`, `transition-step.js`, the
 * tasks-gate, tests) keep importing from the same path.
 */

'use strict';

const {
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
} = require('./task-scope-globs');

const {
  validateTask,
  validateCrossTaskDepsOwnership,
  validateIntraTicketScope,
  validateUniqueOwnership,
  validateTddCycle,
} = require('./task-scope-validators');

const { validateTaskTestScope } = require('./task-scope-test-validator');

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
  errors.push(...validateTddCycle(tasks));
  errors.push(...validateCrossTaskDepsOwnership(tasks));
  errors.push(...validateIntraTicketScope(tasks));
  errors.push(...validateUniqueOwnership(tasks));
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
  validateTddCycle,
  validateCrossTaskDepsOwnership,
  validateIntraTicketScope,
  validateUniqueOwnership,
  validateAll,
  unionFilesInScope,
  findTask,
  extractChangedFilesFromTestCommand,
  extractEvalScopePairs,
  fileMatchesScope,
  isIntegrationTestPath,
  isE2eTestPath,
  usesIntegrationRunner,
  usesUnitRunner,
  usesE2eRunner,
  usesRecognisedRunner,
  detectNonTestCommand,
  TEST_FILE_EXT_RE,
};
