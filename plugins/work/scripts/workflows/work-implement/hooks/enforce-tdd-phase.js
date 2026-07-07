/**
 * enforce-tdd-phase.js
 *
 * TDD phase resolution + enforcement for the work-implement-enforce hook.
 * Per-task tdd-phase.json resolution via allocator (GH-219 R7, R8) with
 * legacy root fallback, plus the GH-570 machine-verified ablation-RED
 * source-edit allowance.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { taskSegment } = require(path.join(__dirname, '..', '..', 'lib', 'allocate-output-folder'));
const { resolveActiveTaskNum, detectWorktreeDir } = require(
  path.join(__dirname, 'enforce-task-paths')
);

/**
 * Resolve the TDD phase state path with per-task support (R7, R8).
 *
 * When WORK_TASK_NUM is set:
 *   - Try per-task path first: TASKS_BASE/<ticket>/task${N}/tdd-phase.json
 *   - Fall back to legacy root: TASKS_BASE/<ticket>/tdd-phase.json
 *
 * When WORK_TASK_NUM is NOT set:
 *   - Use legacy root path
 *
 * @param {string} taskBase - Resolved TASKS_BASE
 * @param {string} safeTicketId - Sanitized ticket ID
 * @returns {string|null} Path to tdd-phase.json, or null if not found
 */
function resolveTddStatePath(taskBase, safeTicketId) {
  // Resolve task number: env var → work state tasksMeta → null (legacy)
  const taskNum = resolveActiveTaskNum(taskBase, safeTicketId);

  if (taskNum) {
    // Try per-task path first
    let segment;
    try {
      segment = taskSegment(taskNum);
    } catch {
      segment = `task${taskNum}`;
    }
    const perTaskPath = path.join(taskBase, safeTicketId, segment, 'tdd-phase.json');
    if (fs.existsSync(perTaskPath)) {
      return perTaskPath;
    }
  }

  // Legacy root fallback
  const rootPath = path.join(taskBase, safeTicketId, 'tdd-phase.json');
  if (fs.existsSync(rootPath)) {
    return rootPath;
  }

  return null;
}

/**
 * GH-570 (W1×W8): during RED, a task whose planner-declared `### Test
 * Strategy` carries `red-mode: ablation` produces its failing RED by
 * TEMPORARILY mutating in-scope SOURCE files — the registry's "only .test
 * or .spec files during RED" rule would deadlock it. The allowance is
 * machine-verified from planner-owned tasks.md via the SHARED
 * implement-gate resolver (resolveTaskTestExecution — the same module the
 * gate, the stop hook, and task-next.js consume; never a parallel copy)
 * and is scope-limited to the task's `### Files in scope`. The caller
 * audit-logs every allow. Fail-closed: any resolution error keeps the
 * RED block.
 */
function _ablationTaskScope(taskBase, safeTicketId, worktreeDir) {
  const taskNum = resolveActiveTaskNum(taskBase, safeTicketId);
  if (!taskNum) return null;
  const shared = require(
    path.join(
      __dirname,
      '..',
      '..',
      'work',
      'lib',
      'step-enrichments',
      'implement-gate',
      'test-command'
    )
  );
  const tasksDir = path.join(taskBase, safeTicketId);
  const execution = shared.resolveTaskTestExecution(tasksDir, taskNum, worktreeDir);
  if (!execution || execution.redMode !== 'ablation') return null;
  const task = shared.findTaskByNum(tasksDir, taskNum);
  return (task && task.filesInScope) || [];
}

function ablationRedEditAllowed(filePath, taskBase, safeTicketId) {
  try {
    if (!filePath || !taskBase) return false;
    const worktreeDir = detectWorktreeDir(safeTicketId);
    if (!worktreeDir) return false;
    const scope = _ablationTaskScope(taskBase, safeTicketId, worktreeDir);
    if (!scope) return false;
    const rel = path.relative(worktreeDir, path.resolve(filePath));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    const { fileInTaskScope } = require(path.join(__dirname, '..', '..', 'lib', 'task-scope'));
    return fileInTaskScope(rel, scope);
  } catch {
    return false; // fail-closed: keep the RED block
  }
}

module.exports = { resolveTddStatePath, ablationRedEditAllowed };
