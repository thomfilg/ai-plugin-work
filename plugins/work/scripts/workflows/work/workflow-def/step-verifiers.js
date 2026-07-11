'use strict';

/**
 * workflow-def/step-verifiers.js — planning-side step verify functions for
 * the /work workflow definition (extracted from workflow-definition.js).
 *
 * Covers the artifact-existence checks up to implementation:
 * ticket, brief, spec, tasks, tasks_gate, implement, task_review, cleanup.
 * All verifiers are fail-closed on read/parse errors.
 *
 * Top-level functions take the shared deps bag as their first argument;
 * `createStepVerifiers(deps)` binds them for the workflow definition.
 *
 * @typedef {Object} StepDeps
 * @property {string} TASKS_BASE
 * @property {Function} safeTicketPath
 * @property {string} workRoot - workflows/work directory (for lib requires)
 */

const path = require('path');
const fs = require('fs');

function ticketDir(deps, ticketId) {
  return path.join(deps.TASKS_BASE, deps.safeTicketPath(ticketId));
}

/** @param {StepDeps} deps */
function verifyTicket(deps, ticketId) {
  // Ticket is proven if the work state file exists and is active for this ticket
  try {
    const stateFile = path.join(ticketDir(deps, ticketId), '.work-state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    return (
      state?.status === 'in_progress' &&
      (state?.ticketId === ticketId || state?.ticketId === deps.safeTicketPath(ticketId))
    );
  } catch {
    return false;
  }
}

/** @param {StepDeps} deps */
function verifyBrief(deps, ticketId) {
  try {
    return fs.existsSync(path.join(ticketDir(deps, ticketId), 'brief.md'));
  } catch {
    return false;
  }
}

/**
 * GH-253: spec is always mandatory — no env toggle bypass.
 * safeTicketPath() converts #N -> GH-N via cached config.safeTicketId()
 * @param {StepDeps} deps
 */
function verifySpec(deps, ticketId) {
  try {
    return fs.existsSync(path.join(ticketDir(deps, ticketId), 'spec.md'));
  } catch {
    return false;
  }
}

/** @param {StepDeps} deps */
function verifyTasks(deps, ticketId) {
  // verify remains active -- used by evidence checks
  try {
    return fs.existsSync(path.join(ticketDir(deps, ticketId), 'tasks.md'));
  } catch {
    return false;
  } // fail-safe: assume tasks not generated
}

/**
 * Gate C — tasks_gate. Verify passes when tasks.md parses and every
 * task declares a non-empty `### Files in scope`
 * (see lib/task-scope.js#validateTask).
 * @param {StepDeps} deps
 */
function verifyTasksGate(deps, ticketId) {
  try {
    const { parseTasks } = require(path.join(deps.workRoot, 'lib', 'task-parser'));
    const { validateAll } = require(path.join(deps.workRoot, '..', 'lib', 'task-scope'));
    const tasks = parseTasks(ticketDir(deps, ticketId));
    if (!tasks) return false;
    return validateAll(tasks).valid;
  } catch {
    return false;
  }
}

/**
 * Exception mode: config-only or mechanical changes that skip TDD.
 * Accepts both legacy string format and structured { category, reason }.
 * If exception-validator fails to load, the caller's catch returns false
 * (fail-closed). Returns null when no exception is declared.
 */
function checkTddException(state, workRoot) {
  if (typeof state.exception === 'string' && state.exception.trim() !== '') return true;
  if (typeof state.exception === 'object' && state.exception !== null) {
    const { ALLOWED_CATEGORIES } = require(
      path.join(workRoot, '..', 'work-implement', 'exception-validator')
    );
    const cat = state.exception.category;
    const reason = state.exception.reason;
    return (
      typeof cat === 'string' &&
      ALLOWED_CATEGORIES.includes(cat) &&
      typeof reason === 'string' &&
      reason.trim() !== ''
    );
  }
  return null;
}

/**
 * GH-694: in multi-task mode, implement is only proven when EVERY tasksMeta
 * task has status 'completed' — the hook-side evidence path previously never
 * read tasksMeta, so implement could verify with unsatisfied tasks (the
 * GH-689 task_4 dangle). Statuses only, no per-task evidence re-walk:
 * evidence was already validated at advance time by the ONE shared validator
 * (re-validating here risks the echo-4552 infinite-retry class). Malformed or
 * missing-status entries count as pending (fail closed); a missing/unreadable
 * .work-state.json or absent tasksMeta is single-task mode — unchanged.
 */
function tasksMetaAllCompleted(deps, ticketId) {
  let tasks;
  try {
    const ws = JSON.parse(
      fs.readFileSync(path.join(ticketDir(deps, ticketId), '.work-state.json'), 'utf-8')
    );
    tasks = ws?.tasksMeta?.tasks;
  } catch {
    return true; // single-task mode / no state file — today's behavior
  }
  if (!Array.isArray(tasks)) return true;
  return tasks.every((t) => t && t.status === 'completed');
}

/**
 * tasks step gating is orchestrator-controlled via DEFER/RUN plan actions.
 * Implement is proven if tdd-phase.json has at least one cycle with red +
 * green evidence AND (GH-694) every tasksMeta task is completed.
 * @param {StepDeps} deps
 */
function verifyImplement(deps, ticketId) {
  try {
    const state = JSON.parse(
      fs.readFileSync(path.join(ticketDir(deps, ticketId), 'tdd-phase.json'), 'utf-8')
    );
    let tddProven;
    const exception = checkTddException(state, deps.workRoot);
    if (exception !== null) {
      tddProven = exception;
    } else if (!Array.isArray(state.cycles) || state.cycles.length === 0) {
      tddProven = false;
    } else {
      // At least one cycle must have both red and green evidence
      tddProven = state.cycles.some((c) => c.red && c.green);
    }
    if (!tddProven) return false;
    return tasksMetaAllCompleted(deps, ticketId);
  } catch {
    return false;
  }
}

/**
 * GH-211: Per-task review gate. Soft check — advisory, not blocking.
 * Verified iff at least one review artifact (task-review-tests.md or
 * task-review-code.md) exists in the ticket's tasks dir.
 * @param {StepDeps} deps
 */
function verifyTaskReview(deps, ticketId) {
  try {
    const dir = ticketDir(deps, ticketId);
    return (
      fs.existsSync(path.join(dir, 'task-review-tests.md')) ||
      fs.existsSync(path.join(dir, 'task-review-code.md'))
    );
  } catch {
    return false;
  }
}

function verifyCleanup(ticketId) {
  // Cleanup is proven if no dev tmux session exists for this ticket
  try {
    const { execFileSync } = require('child_process');
    execFileSync('tmux', ['has-session', '-t', `${ticketId}-dev`], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return false; // Session still exists -- not cleaned up
  } catch {
    return true;
  } // Exit code 1 = session doesn't exist = cleaned up
}

/** @param {StepDeps} deps */
function createStepVerifiers(deps) {
  return {
    verifyTicket: (ticketId) => verifyTicket(deps, ticketId),
    verifyBrief: (ticketId) => verifyBrief(deps, ticketId),
    verifySpec: (ticketId) => verifySpec(deps, ticketId),
    verifyTasks: (ticketId) => verifyTasks(deps, ticketId),
    verifyTasksGate: (ticketId) => verifyTasksGate(deps, ticketId),
    verifyImplement: (ticketId) => verifyImplement(deps, ticketId),
    verifyTaskReview: (ticketId) => verifyTaskReview(deps, ticketId),
    verifyCleanup,
  };
}

module.exports = { createStepVerifiers };
