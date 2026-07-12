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

/**
 * GH-696: a step whose inner phase driver is still mid-flight (or whose
 * ledger is corrupt) must not verify, even when the artifact file exists —
 * on GH-689 the brief step advanced while brief-phase.json sat at `draft`.
 * Absent ledger = legacy/pre-phase-driver ticket → not blocked (today's
 * behavior). The plan matrix's RUN-resume branch is the repair route.
 */
function ledgerClear(deps, ticketId, step) {
  const { phaseLedgerBlocked } = require(path.join(deps.workRoot, 'lib', 'phase-ledger'));
  return !phaseLedgerBlocked(ticketDir(deps, ticketId), step).blocked;
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
    return (
      fs.existsSync(path.join(ticketDir(deps, ticketId), 'brief.md')) &&
      ledgerClear(deps, ticketId, 'brief')
    );
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
    return (
      fs.existsSync(path.join(ticketDir(deps, ticketId), 'spec.md')) &&
      ledgerClear(deps, ticketId, 'spec')
    );
  } catch {
    return false;
  }
}

/** @param {StepDeps} deps */
function verifyTasks(deps, ticketId) {
  // verify remains active -- used by evidence checks
  try {
    return (
      fs.existsSync(path.join(ticketDir(deps, ticketId), 'tasks.md')) &&
      ledgerClear(deps, ticketId, 'tasks')
    );
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
 * missing-status entries count as pending (fail closed); a MISSING
 * .work-state.json (ENOENT) or absent tasksMeta is single-task mode —
 * unchanged. PR #717: a read/parse failure on an EXISTING state file is NOT
 * single-task mode — a corrupt state file on a multi-task ticket must not
 * verify on TDD evidence alone (refusal-to-vouch, the checkpoints.js
 * precedent). Repair route: restore .work-state.json (git checkout / re-run
 * `node work-next.js <ticket>` to rebuild it), then re-verify.
 */
function tasksMetaAllCompleted(deps, ticketId) {
  const statePath = path.join(ticketDir(deps, ticketId), '.work-state.json');
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf-8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return true; // single-task mode / no state file
    return false; // EXISTING but unreadable state file — refuse to vouch
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false; // EXISTING but corrupt state file — refuse to vouch
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.tasksMeta) {
    return true; // falsy tasksMeta — single-task mode (repo-wide idiom), unchanged
  }
  // Once tasksMeta exists this IS a multi-task ticket: statuses must be
  // present and checkable — a missing/non-array tasks field blocks.
  const tasks = parsed.tasksMeta.tasks;
  if (!Array.isArray(tasks)) return false;
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

/**
 * GH-283 R8: strict canonical completion-status matcher. Mirrors the
 * completion_check phase's regex EXACTLY — intentionally rejects the
 * `APPROVED` / `NOT_APPLICABLE` aliases so a mis-marked report cannot pass
 * step verification.
 */
const STATUS_COMPLETE_RE = /^\s*\*\*Status:\*\*\s*COMPLETE\b/im;

/**
 * GH-283 R8: completion evidence is present iff `<tasksDir>/completion.check.md`
 * exists AND contains the canonical `**Status:** COMPLETE` line. Fail-OPEN
 * (returns `null`) only when the tasks-dir cannot be resolved — that is the one
 * unresolvable case where we fall back to the tmux-only invariant. A present
 * file with a wrong/absent status returns `false` (fail closed).
 * @param {StepDeps} deps
 * @returns {boolean|null} true=COMPLETE, false=present-but-wrong/missing, null=unresolvable dir
 */
function completionEvidencePresent(deps, ticketId) {
  let dir;
  try {
    dir = ticketDir(deps, ticketId);
  } catch {
    return null; // tasks-dir unresolvable → fail open to tmux-only invariant
  }
  if (!dir) return null;
  let raw;
  try {
    raw = fs.readFileSync(path.join(dir, 'completion.check.md'), 'utf-8');
  } catch {
    return false; // absent or unreadable → fail closed
  }
  return STATUS_COMPLETE_RE.test(raw);
}

/**
 * GH-283 R8: cleanup is proven only when BOTH the dev tmux session is gone
 * AND completion evidence (`**Status:** COMPLETE`) is present. This closes the
 * runner-bypass gap where skipping the completion_check phase left no marker
 * yet cleanup still verified on tmux-absence alone. Fail-open on an
 * unresolvable tasks-dir only (falls back to the tmux-only invariant).
 * @param {StepDeps} deps
 */
function verifyCleanup(deps, ticketId) {
  // 1) tmux dev session must be gone.
  let tmuxGone;
  try {
    const { execFileSync } = require('child_process');
    execFileSync('tmux', ['has-session', '-t', `${ticketId}-dev`], {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    tmuxGone = false; // Session still exists -- not cleaned up
  } catch {
    tmuxGone = true; // Exit code 1 = session doesn't exist = cleaned up
  }
  if (!tmuxGone) return false;

  // 2) completion evidence must be present (fail-open only on unresolvable dir).
  const evidence = completionEvidencePresent(deps, ticketId);
  if (evidence === null) return true; // unresolvable dir → tmux-only invariant
  return evidence;
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
    verifyCleanup: (ticketId) => verifyCleanup(deps, ticketId),
  };
}

module.exports = { createStepVerifiers };
