/**
 * task-scope-context.js
 *
 * Active-ticket / active-task discovery for the protect-task-scope hook
 * (Gate D). Looks up:
 *   - Active ticket via .git/HEAD ([A-Z]+-\d+ match)
 *   - tasksDir = TASKS_BASE/safeTicketId(ticket)
 *   - .work-state.json → tasksMeta.currentTaskIndex
 *   - tasks.md → active task → filesInScope / filesOutOfScope
 */

'use strict';

const fs = require('fs');
const path = require('path');

const config = require(path.join(__dirname, '..', '..', 'lib', 'config'));
const { parseTasks } = require(path.join(__dirname, '..', '..', 'work', 'lib', 'task-parser'));

// ─── Active-ticket discovery (mirrors enforce-step-workflow.getTicketId) ────

function readGitHead(cwd) {
  try {
    const gitPath = path.join(cwd, '.git');
    const st = fs.statSync(gitPath);
    if (st.isFile()) {
      // worktree pointer
      const raw = fs.readFileSync(gitPath, 'utf8').trim();
      if (raw.startsWith('gitdir: ')) {
        const gitDir = raw.slice('gitdir: '.length);
        const headPath = path.isAbsolute(gitDir)
          ? path.join(gitDir, 'HEAD')
          : path.join(cwd, gitDir, 'HEAD');
        return fs.readFileSync(headPath, 'utf8').trim();
      }
    }
    return fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf8').trim();
  } catch {
    return null;
  }
}

function getTicketId(cwd) {
  if ('PROTECT_TASK_SCOPE_TICKET_ID' in process.env) {
    return process.env.PROTECT_TASK_SCOPE_TICKET_ID || null;
  }
  const head = readGitHead(cwd);
  if (!head) return null;
  const ref = head.startsWith('ref: ') ? head.slice(5) : head;
  const m = ref.match(/[A-Z]+-\d+/i);
  return m ? m[0] : null;
}

// ─── State + tasks resolution ───────────────────────────────────────────────

function getTasksDir(ticketId) {
  if (!ticketId) return null;
  const base = config.TASKS_BASE;
  if (!base) return null;
  const safe = typeof config.safeTicketId === 'function' ? config.safeTicketId(ticketId) : ticketId;
  return path.join(base, safe);
}

function loadWorkState(tasksDir) {
  try {
    const p = path.join(tasksDir, '.work-state.json');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Current step: explicit currentStep string, else the first in_progress status. */
function resolveCurrentStep(ws) {
  if (typeof ws.currentStep === 'string') return ws.currentStep;
  const stepStatus = ws.stepStatus;
  return stepStatus && Object.keys(stepStatus).find((k) => stepStatus[k] === 'in_progress');
}

function shapeActiveTask(task, taskNum) {
  return {
    taskNum,
    label: `Task ${task.num}${task.title ? ' — ' + task.title : ''}`,
    filesInScope: Array.isArray(task.filesInScope) ? task.filesInScope : [],
    filesOutOfScope: Array.isArray(task.filesOutOfScope) ? task.filesOutOfScope : [],
    // GH-392 Task 8 / spec §P0#7b: cross-task allow-list. Files declared here
    // are out of the task's primary scope but are legitimately needed (owned
    // by sibling tasks). decideEdit blocks would be overridden to exit 0 with
    // a `cross-task-dep-allow` audit row.
    crossTaskDeps: Array.isArray(task.crossTaskDeps) ? task.crossTaskDeps : [],
    // GH-528 item 5: per-Type allowlist layer. tdd-code / checkpoint /
    // mechanical-refactor / file-move keep existing behavior (no per-Type
    // restriction beyond the filesInScope/filesOutOfScope check). The
    // closed-allowlist types (tests-only, docs, config, ci) additionally
    // require the write target to match their per-Type pattern set in
    // skills/split-in-tasks/lib/task-types.js.
    type: typeof task.type === 'string' ? task.type : '',
  };
}

function findCurrentTask(tasksDir, ws) {
  const meta = ws.tasksMeta;
  if (!meta || !Array.isArray(meta.tasks)) return null;
  const idx = typeof meta.currentTaskIndex === 'number' ? meta.currentTaskIndex : 0;

  let tasks;
  try {
    tasks = parseTasks(tasksDir);
  } catch {
    return null;
  }
  if (!tasks) return null;

  const taskNum = idx + 1;
  const task = tasks.find((t) => t.num === taskNum);
  if (!task) return null;
  return shapeActiveTask(task, taskNum);
}

function getActiveTask(tasksDir) {
  const ws = loadWorkState(tasksDir);
  if (!ws) return null;

  // Only enforce during the implement step. Other steps may write tasks.md,
  // brief.md, etc., and shouldn't be blocked by Gate D.
  const currentStep = resolveCurrentStep(ws);
  if (currentStep && currentStep !== 'implement') return { skip: true };

  return findCurrentTask(tasksDir, ws);
}

module.exports = { getTicketId, getTasksDir, getActiveTask };
