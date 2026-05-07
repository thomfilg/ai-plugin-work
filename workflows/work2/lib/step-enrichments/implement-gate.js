/**
 * Implement multi-task gate.
 *
 * Prevents the implement step from advancing to commit when there are
 * remaining tasks. When TDD evidence exists for the current task but
 * more tasks remain, advances the task pointer and signals a re-dispatch.
 *
 * This is work2-specific orchestration — the shared transition-step.js
 * only validates TDD evidence per-task, it does NOT enforce multi-task
 * iteration. That responsibility lives here.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

/**
 * Check if the implement step can advance, handling multi-task iteration.
 *
 * @param {string} safeName - Sanitized ticket ID
 * @param {object} deps - Dependencies injected from work-next.js
 * @param {Function} deps.loadWorkState
 * @param {Function} deps.saveWorkState
 * @param {Function} deps.readTddEvidence
 * @param {string} deps.stepName - Current step name (e.g., 'implement')
 * @param {string} deps.workDir - Path to workflows/work/
 * @param {Function} deps.log - Debug logger
 * @param {number} deps.recursionDepth
 * @returns {{ action: 'advance' | 'evidence-missing' | 'none', taskNum?: number }}
 */
function checkMultiTaskGate(safeName, deps) {
  const { loadWorkState, saveWorkState, readTddEvidence, stepName, workDir, log, recursionDepth } =
    deps;

  const ws = loadWorkState(safeName);
  if (!ws?.tasksMeta || !Array.isArray(ws.tasksMeta.tasks)) {
    return { action: 'none' };
  }

  const currentIdx = ws.tasksMeta.currentTaskIndex ?? 0;
  const totalTasks = ws.tasksMeta.tasks.length;
  const taskNum = currentIdx + 1; // 1-indexed

  // Check if TDD evidence exists for the current task
  const { exists: hasEvidence } = readTddEvidence(safeName, stepName, taskNum);

  if (!hasEvidence) {
    return { action: 'evidence-missing', taskNum };
  }

  // Evidence exists — check if more tasks remain
  if (currentIdx < totalTasks - 1) {
    // Advance task pointer
    try {
      execFileSync(
        process.execPath,
        [path.join(workDir, 'work-state.js'), 'task-advance', safeName],
        { encoding: 'utf-8', timeout: 5000, stdio: 'pipe' }
      );
      // Clear dispatched marker so the new task gets dispatched fresh
      const ws2 = loadWorkState(safeName);
      if (ws2) {
        delete ws2._work2Dispatched;
        delete ws2._work2DispatchedAction;
        saveWorkState(safeName, ws2);
      }
      if (log) {
        log.recurse(recursionDepth, `task-advance ${currentIdx + 1} → ${currentIdx + 2}`);
      }
      return { action: 'advance', taskNum: currentIdx + 2 };
    } catch {
      return { action: 'none' };
    }
  }

  // All tasks done, evidence exists — transition can proceed
  return { action: 'none' };
}

module.exports = { checkMultiTaskGate };
