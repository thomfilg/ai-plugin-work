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
const { markProgress } = require(path.join(__dirname, '..', 'mark-task-progress'));

/**
 * Dispatch-advance gate for the implement step.
 *
 * Called by work-next.js when a dispatched step's transition is blocked.
 * Returns null (no action), { recurse: true } (re-run orchestrator),
 * or a full instruction object (return to caller).
 *
 * @param {string} safeName - Sanitized ticket ID
 * @param {object} ctx - Context from work-next.js
 * @param {string} ctx.ticket - Display ticket ID (e.g., '#279')
 * @param {object} ctx.stateCtx - State context for instruction building
 * @param {object} deps - Dependencies injected from work-next.js
 * @param {Function} deps.loadWorkState
 * @param {Function} deps.saveWorkState
 * @param {Function} deps.readTddEvidence
 * @param {string} deps.stepName - Current step name (e.g., 'implement')
 * @param {string} deps.workDir - Path to workflows/work/
 * @param {string} deps.work2Dir - Path to workflows/work2/
 * @param {Function} deps.log - Debug logger
 * @param {number} deps.recursionDepth
 * @returns {null | { recurse: true } | object} - null=no action, recurse=re-run, object=instruction
 */
function dispatchAdvanceGate(safeName, ctx, deps) {
  const {
    loadWorkState,
    saveWorkState,
    readTddEvidence,
    stepName,
    workDir,
    work2Dir,
    log,
    recursionDepth,
  } = deps;

  const ws = loadWorkState(safeName);
  if (!ws?.tasksMeta || !Array.isArray(ws.tasksMeta.tasks)) {
    return null;
  }

  const currentIdx = ws.tasksMeta.currentTaskIndex ?? 0;
  const totalTasks = ws.tasksMeta.tasks.length;
  const taskNum = currentIdx + 1; // 1-indexed

  // Check if TDD evidence exists for the current task
  const { exists: hasEvidence } = readTddEvidence(safeName, stepName, taskNum);

  // No evidence — return instruction to record it
  if (!hasEvidence) {
    const tddNextPath = path.join(work2Dir, 'tdd-next.js');
    const taskFlag = taskNum ? ` --task ${taskNum}` : '';
    const instr = {
      type: 'work_instruction',
      action: 'execute',
      state: { ...ctx.stateCtx, currentStep: stepName },
      continue: true,
      delegate: {
        type: 'task',
        agentType: 'developer-nodejs-tdd',
        description: `record TDD evidence for task ${taskNum}`,
        prompt: [
          '## TDD Evidence Missing',
          '',
          'The implementation work is done but TDD evidence was NOT recorded.',
          'The workflow CANNOT advance without it.',
          '',
          '**You MUST run these commands in order:**',
          '',
          '```bash',
          `node "${tddNextPath}" ${ctx.ticket}${taskFlag}`,
          '```',
          '',
          'Follow the instructions from tdd-next.js to record evidence for each phase (init → red → green → refactor).',
          'Run the test command at each phase to generate real evidence.',
          '',
          'DO NOT skip any phase. DO NOT re-implement code. Just record evidence.',
        ].join('\n'),
      },
    };
    if (log) log.instruction(instr);
    return instr;
  }

  // Evidence exists but more tasks remain — advance task pointer
  if (currentIdx < totalTasks - 1) {
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
      // Update tasks.md checkboxes to reflect progress
      if (ctx.tasksDir) {
        try {
          markProgress(ctx.tasksDir);
        } catch {
          /* fail-open */
        }
      }
      if (log) {
        log.recurse(recursionDepth, `task-advance ${currentIdx + 1} → ${currentIdx + 2}`);
      }
      return { recurse: true };
    } catch {
      return null;
    }
  }

  // All tasks done, evidence exists — update checkboxes and allow transition
  if (ctx.tasksDir) {
    try {
      markProgress(ctx.tasksDir);
    } catch {
      /* fail-open */
    }
  }
  return null;
}

module.exports = { dispatchAdvanceGate };
