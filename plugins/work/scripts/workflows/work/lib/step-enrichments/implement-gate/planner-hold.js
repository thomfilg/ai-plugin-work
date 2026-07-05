/**
 * W3 — operator-hold for planner defects surfaced by the implement gate.
 *
 * When a retry is recorded with `plannerDefect: true` (malformed
 * `### Test Strategy`, hanging test command, unset test envelope, …) the
 * defect lives in tasks.md — which is planner-owned and LOCKED during
 * implement — so re-dispatching developer agents at it burns retries on a
 * problem no implementing agent is allowed to fix. This module:
 *
 *   1. Builds the operator-hold instruction the gate returns INSTEAD of
 *      re-dispatching: it tells the main /work session to surface the defect
 *      to the operator (AskUserQuestion) with the two safe remediations —
 *      the operator corrects tasks.md outside the session, or re-runs the
 *      tasks phase.
 *   2. Hashes the defective task's `## Task N` section at record time and
 *      auto-clears the hold on a later gate pass once that hash changes
 *      (machine-verified from on-disk tasks.md — never trusted free text).
 *      The gate reconciler already re-syncs tasksMeta on the same pass.
 *
 * No new bypass surface: the hold clears ONLY when tasks.md content for the
 * task actually changed; there is no env var or free-text override.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** Keys that scope a retry-failure block to a specific task. */
const RETRY_KEYS = [
  '_tddRetryReason',
  '_tddRetryCount',
  '_tddRetryCommand',
  '_tddRetryExitCode',
  '_tddRetryOutputTail',
  '_tddRetryTask',
  '_tddRetryPlannerDefect',
  '_tddRetryTasksHash',
  '_tddRetryDefectKind',
];

/** Delete all per-task retry state from the work-state object. */
function clearRetryState(ws) {
  for (const k of RETRY_KEYS) delete ws[k];
}

/**
 * sha256 of the `## Task N` section of tasks.md (whole file when the section
 * cannot be isolated), or null when tasks.md is unreadable. Used to detect
 * that the operator actually changed the defective task definition.
 */
function computeTaskSectionHash(tasksDir, taskNum) {
  if (!tasksDir) return null;
  let content;
  try {
    content = fs.readFileSync(path.join(tasksDir, 'tasks.md'), 'utf8');
  } catch {
    return null;
  }
  const num = Number(taskNum);
  let section = content;
  if (Number.isInteger(num) && num > 0) {
    const m = content.match(new RegExp(`(?:^|\\n)## Task ${num}\\b[\\s\\S]*?(?=\\n## Task \\d|$)`));
    if (m) section = m[0];
  }
  return crypto.createHash('sha256').update(section).digest('hex');
}

/**
 * Persist retry-failure context on the work state so the next dispatch prompt
 * can surface the exact command, exit code, and output to the agent. When the
 * failure is a planner defect (W3/W5/W6 — hang, unset envelope, malformed
 * strategy), `extras.plannerDefect` marks the retry so the dispatch layer
 * holds for the operator instead of re-dispatching developer agents at a
 * defect they cannot fix (tasks.md is planner-owned and locked). The per-task
 * section hash recorded alongside is what later clears the hold.
 *
 * @param {{ ws: object, taskNum: number, tasksDir: string|null,
 *           saveWorkState: Function, safeName: string }} gate
 * @param {string} reason
 * @param {object} [extras]
 */
function persistRetryFailure(gate, reason, extras) {
  const { ws, taskNum, tasksDir, saveWorkState, safeName } = gate;
  const e = extras || {};
  ws._tddRetryReason = reason;
  ws._tddRetryCount = (ws._tddRetryCount || 0) + 1;
  ws._tddRetryCommand = e.command || null;
  ws._tddRetryExitCode = e.exitCode ?? null;
  ws._tddRetryOutputTail = e.outputTail || '';
  ws._tddRetryTask = taskNum;
  if (e.plannerDefect) {
    ws._tddRetryPlannerDefect = true;
    // Defect kind ('malformed-strategy' | 'unset-envelope' | 'hang') — the
    // statically re-checkable kinds are re-probed by resolvePlannerHold so
    // the hold can also clear via a fix OUTSIDE tasks.md (e.g. `.envrc`).
    if (e.defectKind) ws._tddRetryDefectKind = e.defectKind;
    const hash = computeTaskSectionHash(tasksDir, taskNum);
    if (hash) ws._tddRetryTasksHash = hash;
  }
  saveWorkState(safeName, ws);
}

/**
 * The instruction the gate returns while a planner defect is unresolved.
 * `action: 'blocked'` so the main session stops; the suggestion instructs it
 * to hold for the operator instead of re-dispatching a developer agent.
 */
function buildPlannerHoldInstruction(ws, safeName) {
  const taskNum = ws._tddRetryTask ?? null;
  return {
    type: 'work_instruction',
    action: 'blocked',
    hold: 'planner-defect',
    state: { ticket: safeName, currentStep: 'implement' },
    reason: `Planner defect on task ${taskNum ?? '?'}: ${ws._tddRetryReason || 'unknown defect'}`,
    defect: {
      task: taskNum,
      command: ws._tddRetryCommand || null,
      exitCode: ws._tddRetryExitCode ?? null,
      outputTail: ws._tddRetryOutputTail || '',
    },
    suggestion: [
      'OPERATOR HOLD — do NOT re-dispatch a developer agent: the defect is in',
      'tasks.md, which is planner-owned and LOCKED during implement, so no',
      'implementing agent may correct it. Surface the defect above to the',
      'operator with AskUserQuestion, offering:',
      `  1. Operator corrects the "## Task ${taskNum ?? '?'}" section of tasks.md outside`,
      '     the session — the gate hashes that section and resumes the normal',
      '     flow automatically once its content changes (tasksMeta is re-synced',
      '     by the gate reconciler on the same pass).',
      '  2. Re-run the tasks phase to regenerate tasks.md.',
    ].join('\n'),
  };
}

/**
 * Statically re-checkable defect kinds. The tasks.md section hash is ONE
 * clearing trigger, not the only one (downstream review, W6): the unset-
 * envelope defect's advertised remediation ("the worktree `.envrc` must
 * export the variable") lives OUTSIDE tasks.md, so hash-only clearing made
 * that hold permanent. These predicates can be re-evaluated without
 * EXECUTING anything (strategy resolution + malformed/unset detection are
 * pure reads), so the hold is re-probed on every gate pass and cleared when
 * the defect no longer reproduces — machine-verified from on-disk
 * tasks.md/.envrc, never free text. 'hang' is deliberately excluded:
 * re-probing it would re-run the hanging command.
 */
const STATIC_DEFECT_KINDS = new Set(['malformed-strategy', 'unset-envelope']);

function defectStillReproduces(ws, ctx) {
  if (!STATIC_DEFECT_KINDS.has(ws._tddRetryDefectKind)) return true;
  try {
    // Same shared modules the gate flow itself uses (never a parallel copy):
    // resolution via test-command.js, env via evidence-flow's buildRunEnv.
    const { readTaskTestCommand, detectMalformedTestCommand, detectUnsetEnvelopeCommand } = require(
      path.join(__dirname, 'test-command')
    );
    const { resolveWorkingDir, buildRunEnv } = require(path.join(__dirname, 'evidence-flow'));
    const tasksDir = ctx && ctx.tasksDir;
    if (!tasksDir) return true;
    const workingDir = resolveWorkingDir(ctx, ws);
    const cmd = readTaskTestCommand(tasksDir, ws._tddRetryTask, workingDir);
    if (!cmd) return true; // still no runnable resolution — defect stands
    if (detectMalformedTestCommand(cmd)) return true;
    const runEnv = buildRunEnv(path.dirname(tasksDir), workingDir);
    if (detectUnsetEnvelopeCommand(cmd, runEnv)) return true;
    return false; // predicate no longer fires — safe to resume
  } catch {
    return true; // fail-safe: keep holding rather than resume on an error
  }
}

/**
 * Pre-flow check run at the top of every implement gate pass.
 *
 * Returns null when there is no active planner-defect hold — including the
 * resume cases: the task's tasks.md section hash changed since the defect
 * was recorded, OR a statically re-checkable defect predicate no longer
 * reproduces (e.g. the operator exported the missing envelope var in the
 * worktree `.envrc` — no tasks.md change involved). Retry state is cleared
 * and the normal flow continues. Returns the operator-hold instruction while
 * the defect is unresolved, so the gate never re-runs a defective command or
 * re-dispatches an agent at it.
 */
/** True when either clearing trigger fired: hash change OR static re-probe. */
function _holdCleared(ws, ctx, current) {
  if (current && ws._tddRetryTasksHash && current !== ws._tddRetryTasksHash) return true;
  return !defectStillReproduces(ws, ctx);
}

function resolvePlannerHold({ ws, ctx, saveWorkState, safeName }) {
  if (!ws._tddRetryPlannerDefect) return null;

  const current = computeTaskSectionHash(ctx && ctx.tasksDir, ws._tddRetryTask);
  if (_holdCleared(ws, ctx, current)) {
    clearRetryState(ws);
    try {
      saveWorkState(safeName, ws);
    } catch {
      /* fail-open — resume anyway; state re-saves on the next recordRetry */
    }
    return null;
  }

  // Backfill the hash when record time could not compute one (unreadable
  // tasks.md), so a later operator fix is still detectable.
  if (current && !ws._tddRetryTasksHash) {
    ws._tddRetryTasksHash = current;
    try {
      saveWorkState(safeName, ws);
    } catch {
      /* fail-open */
    }
  }

  return buildPlannerHoldInstruction(ws, safeName);
}

module.exports = {
  RETRY_KEYS,
  clearRetryState,
  computeTaskSectionHash,
  persistRetryFailure,
  buildPlannerHoldInstruction,
  resolvePlannerHold,
};
