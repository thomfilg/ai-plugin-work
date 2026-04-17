/**
 * preflight.js
 *
 * IDEA2 / GH-219 — Task 3: Shared preflight gate with audit hook.
 *
 * `runPreflight(context, options)` is the single evaluation surface consumed
 * by `workflows/work/hooks/work-require-implement.js` and
 * `workflows/work-implement/hooks/work-implement-enforce.js`. It returns a
 * {@link PreflightResult} and invokes an optional {@link PreflightAudit}
 * callback so enforcement decisions can be persisted to `.work-actions.json`
 * via `appendEnforcementAudit` (Task 1) WITHOUT this module importing
 * `work-actions.js` (low coupling; audit is injected by callers).
 *
 * The `context` parameter matches the `EnforcementContext` shape returned by
 * `workflows/work/work-enforcement-context.js` (Task 2). The JSDoc `@param`
 * below imports that type by name via a TypeScript-compatible `import(...)`
 * specifier so downstream tooling (tsc in checkJs mode, Cursor/VSCode
 * IntelliSense) resolves the fields without a runtime require — preflight
 * remains decoupled from the adapter.
 *
 * @module preflight
 */
'use strict';

const path = require('path');

/**
 * @typedef {import('../work/work-enforcement-context').EnforcementContext} EnforcementContext
 *
 * Unified enforcement context composed by `loadEnforcementContext` in
 * `workflows/work/work-enforcement-context.js` (Task 2). Contains:
 *   - `ticketId`    {string|null}           sanitized ticket id, null on validation error
 *   - `origin`      {'workflow'|'ai-subtask'|'user'|null} derived origin
 *   - `state`       {object|null}           result from `loadState(ticketId)`
 *   - `tasks`       {object[]|null}         result from `parseTasks(tasksDir)`
 *   - `subtaskState` {object|null}          active subtask state or null
 *   - `hasWorkflow` {boolean}               convenience signal
 *   - `error`       {EnforcementContextError|null} populated on ambiguity / bad id
 *   - `options`     {object}                echo of caller options
 */

/**
 * @typedef {import('../work/work-enforcement-context').EnforcementContextError} EnforcementContextError
 *
 * Structured error descriptor attached to `EnforcementContext.error`:
 *   - `code`        {string}   stable identifier (e.g. 'AMBIGUOUS_SUBTASK')
 *   - `message`     {string}   human-readable description
 *   - `remediation` {string[]} actionable fix steps (may be empty)
 */

/**
 * Final preflight decision consumed by hooks.
 *
 * @typedef {Object} PreflightResult
 * @property {boolean}  allow       `true` iff no deny reasons collected.
 * @property {string[]} reasons     Deny reason codes (stable rule ids),
 *                                  aggregated across `context.error` and
 *                                  every denying check. Empty on allow.
 * @property {string[]} remediation Merged, ordered remediation steps for
 *                                  R18 explainability. Empty on allow.
 */

/**
 * Audit record passed to the injected audit callback.
 *
 * Fields are a superset of `appendEnforcementAudit` (Task 1) inputs so
 * callers can forward this entry directly to persistence — preflight never
 * imports `work-actions.js`.
 *
 * @typedef {Object} PreflightAuditEntry
 * @property {'allow'|'deny'}                         decision
 * @property {string[]}                                reasons
 * @property {string[]}                                remediation
 * @property {'workflow'|'ai-subtask'|'user'|null}     origin
 * @property {string|null}                             ticketId
 */

/**
 * Callable signature for an injected audit hook. Single positional argument
 * (plain object). Return value is ignored. Callback exceptions are caught
 * and suppressed by `runPreflight` (fail-open on logging).
 *
 * @typedef {(entry: PreflightAuditEntry) => void} PreflightAudit
 */

/**
 * Callable signature for a pluggable preflight check.
 *
 * Returning `null`/`undefined` or `{ allow: true }` is "no opinion" and
 * passes through. Returning `{ allow: false, reasons?, remediation? }`
 * contributes to the aggregated deny result. A thrown check is caught and
 * recorded as `PREFLIGHT_CHECK_ERROR` (fail-closed) — it cannot starve the
 * gate.
 *
 * @typedef {(ctx: EnforcementContext) => (Partial<PreflightResult>|null|undefined)} PreflightCheck
 */

/**
 * Options for {@link runPreflight}.
 *
 * @typedef {Object} PreflightOptions
 * @property {PreflightAudit}   [audit]   Injected logger; defaults to no-op.
 * @property {PreflightCheck[]} [checks]  Pluggable checks run in order.
 */

/**
 * Run the preflight gate.
 *
 * Semantics:
 *   1. If `context.error` is a truthy object with a non-empty string `code`,
 *      the error is recorded as a deny reason and its `remediation` (when an
 *      array) is merged into the result.
 *   2. If `options.checks` is provided, each check runs IN ORDER with
 *      `context` as its sole argument. All denying results are aggregated —
 *      reasons concatenated, remediation merged in declared order. A single
 *      thrown check is caught and recorded as `PREFLIGHT_CHECK_ERROR`
 *      (fail-closed) so one buggy rule cannot crash the whole gate.
 *   3. The final `allow` is `true` iff no deny reasons were collected.
 *   4. If `options.audit` is a function, it is invoked exactly once with a
 *      single {@link PreflightAuditEntry}. The callback is wrapped in a
 *      try/catch so logging failures never break enforcement (mirrors
 *      `work-actions.js` `appendRow()` fail-open).
 *   5. If `options.audit` is missing / not a function, audit defaults to a
 *      no-op.
 *
 * The function is declared with arity 2 (no default parameters) so
 * `runPreflight.length === 2`, locking the documented public contract.
 *
 * @param {EnforcementContext} context
 *   Enforcement context produced by `loadEnforcementContext`
 *   (`workflows/work/work-enforcement-context.js`, Task 2).
 * @param {PreflightOptions} [options]
 * @returns {PreflightResult}
 */
function runPreflight(context, options) {
  const ctx = context || {};
  const opts = options || {};

  const audit = typeof opts.audit === 'function' ? opts.audit : null;
  const checks = Array.isArray(opts.checks) ? opts.checks : null;

  const reasons = [];
  const remediation = [];

  // ─── 1. context.error → deny with error.code as the rule id ────────────
  const err = ctx.error;
  if (err && typeof err === 'object' && typeof err.code === 'string' && err.code.length > 0) {
    reasons.push(err.code);
    if (Array.isArray(err.remediation)) {
      for (const step of err.remediation) {
        remediation.push(step);
      }
    }
  }

  // ─── 2. Pluggable checks ───────────────────────────────────────────────
  if (checks) {
    for (const check of checks) {
      if (typeof check !== 'function') continue;

      let res;
      try {
        res = check(ctx);
      } catch {
        // Fail-closed on a crashing check — one buggy rule must not starve
        // the gate. The synthetic reason lets callers identify the failure
        // mode in audit records without leaking error internals.
        reasons.push('PREFLIGHT_CHECK_ERROR');
        continue;
      }

      if (!res || typeof res !== 'object') continue;
      if (res.allow === false) {
        if (Array.isArray(res.reasons)) {
          for (const r of res.reasons) reasons.push(r);
        }
        if (Array.isArray(res.remediation)) {
          for (const r of res.remediation) remediation.push(r);
        }
      }
    }
  }

  // ─── 3. Final decision ─────────────────────────────────────────────────
  const allow = reasons.length === 0;
  const decision = allow ? 'allow' : 'deny';
  const result = { allow, reasons, remediation };

  // ─── 4. Fail-open audit ────────────────────────────────────────────────
  // Entry fields are a superset of {decision, reasons, origin, ticketId} so
  // callers can forward directly to `appendEnforcementAudit` (Task 1).
  // `remediation` is included for R18 explainability (deny path).
  if (audit) {
    try {
      audit({
        decision,
        reasons,
        remediation,
        origin: ctx.origin != null ? ctx.origin : null,
        ticketId: ctx.ticketId != null ? ctx.ticketId : null,
      });
    } catch {
      // Persistence failures must never break enforcement decisions.
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Task 12 — Preflight rules integration (graph, claim, paths)
//
// Built-in check factories and shared path predicate.
//   - createGraphCheck()                → PreflightCheck  (R4)
//   - createClaimCheck({ taskNum, ownerId }) → PreflightCheck  (R3, R6)
//   - createPathCheck({ filePath, allowedPaths }) → PreflightCheck  (R6)
//   - isWriteAllowedPath(filePath, allowedPaths) → boolean  (R6, R12)
//
// isWriteAllowedPath is the single implementation of the path predicate.
// Tasks 13-14 hooks import it from here — no inline copies allowed.
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Shared-root whitelist (R6) ──────────────────────────────────────────────
// Files at ticketRoot that any worker may write (coordination files).
const SHARED_ROOT_WHITELIST = new Set([
  'brief.md',
  'spec.md',
  'tasks.md',
  '.work-state.json',
  '.work-actions.json',
]);

/**
 * Determine whether a file path is allowed for the current worker.
 *
 * This is the SINGLE implementation of the task-readiness edit gate (R6).
 * Tasks 13-14 hooks must import this — no inline duplicates.
 *
 * Allowed paths:
 *   - Under `allowedPaths.prDir`      (PR{N}/ worktree)
 *   - Under `allowedPaths.taskDir`    (task${N}/ artifacts)
 *   - Shared-root whitelist at `allowedPaths.ticketRoot`
 *
 * Fail-closed (R15): returns false when inputs are missing or malformed.
 *
 * @param {string} filePath     - Absolute path being written
 * @param {object} allowedPaths - { prDir, taskDir, ticketRoot }
 * @returns {boolean}
 */
function isWriteAllowedPath(filePath, allowedPaths) {
  if (!filePath || typeof filePath !== 'string') return false;
  if (!allowedPaths || typeof allowedPaths !== 'object') return false;

  // Normalize to prevent path-traversal bypasses (R15)
  const normalized = path.resolve(filePath);

  // Check PR{N}/ directory
  if (typeof allowedPaths.prDir === 'string' && allowedPaths.prDir.length > 0) {
    const prResolved = path.resolve(allowedPaths.prDir);
    if (normalized.startsWith(prResolved + path.sep) || normalized === prResolved) {
      return true;
    }
  }

  // Check task${N}/ directory
  if (typeof allowedPaths.taskDir === 'string' && allowedPaths.taskDir.length > 0) {
    const taskResolved = path.resolve(allowedPaths.taskDir);
    if (normalized.startsWith(taskResolved + path.sep) || normalized === taskResolved) {
      return true;
    }
  }

  // Check shared-root whitelist at ticketRoot
  if (typeof allowedPaths.ticketRoot === 'string' && allowedPaths.ticketRoot.length > 0) {
    const ticketResolved = path.resolve(allowedPaths.ticketRoot);
    // File must be directly at ticketRoot (not nested) and in the whitelist
    const dir = path.dirname(normalized);
    if (dir === ticketResolved) {
      const basename = path.basename(normalized);
      if (SHARED_ROOT_WHITELIST.has(basename)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Create a graph validation check (R4).
 *
 * Validates `ctx.tasks` for unknown dependencies, self-dependencies, and
 * cycles using `validateTaskGraph` from `work-state.js`. If tasks are null
 * or missing, the check passes (no graph to validate).
 *
 * @returns {PreflightCheck}
 */
function createGraphCheck() {
  return function graphCheck(ctx) {
    if (!ctx.tasks || !Array.isArray(ctx.tasks)) return null;

    // Lazy require to avoid module-level coupling with work-state.js.
    // In production config is always available; if require fails, the
    // enclosing runPreflight try/catch records PREFLIGHT_CHECK_ERROR.
    const { validateTaskGraph } = require('../work/work-state');

    const validation = validateTaskGraph(ctx.tasks);
    if (validation.valid) return null;

    // Aggregate all graph errors into reasons + remediation
    const reasons = [];
    const remediation = [];
    for (const err of validation.errors) {
      if (err.code && !reasons.includes(err.code)) {
        reasons.push(err.code);
      }
      if (Array.isArray(err.remediation)) {
        for (const step of err.remediation) {
          remediation.push(step);
        }
      }
    }

    return { allow: false, reasons, remediation };
  };
}

/**
 * Create a claim + dependency readiness check (R3, R6).
 *
 * Validates that:
 *   1. If taskNum is set, ownerId must also be set (unclaimed write → deny).
 *   2. The task's dependencies are all completed (canStart semantics, R3).
 *
 * When no tasksMeta exists in the context state, the check passes (legacy
 * mode, R16 backward compat).
 *
 * @param {object} params
 * @param {number} [params.taskNum] - Task number being worked on
 * @param {string} [params.ownerId] - PR{N} owner id from claim
 * @returns {PreflightCheck}
 */
function createClaimCheck(params) {
  const taskNum = params && params.taskNum;
  const ownerId = params && params.ownerId;

  return function claimCheck(ctx) {
    // No state or no tasksMeta → legacy mode, allow (R16)
    if (!ctx.state || !ctx.state.tasksMeta) return null;

    // No taskNum requested → no claim enforcement needed
    if (!taskNum) return null;

    // R6: taskNum set but no ownerId → unclaimed task write
    if (!ownerId) {
      return {
        allow: false,
        reasons: ['UNCLAIMED_TASK_WRITE'],
        remediation: [
          `Task ${taskNum} has no claim. Run claimTask(ticketId, ${taskNum}, ownerId) before writing.`,
          'Each worker must claim a task with its PR{N} owner id before modifying files.',
        ],
      };
    }

    // R3: Check dependency readiness using persisted tasksMeta
    const tasksMeta = ctx.state.tasksMeta;
    if (!Array.isArray(tasksMeta.tasks)) return null;

    const targetId = `task_${taskNum}`;
    const task = tasksMeta.tasks.find((t) => t && t.id === targetId);
    if (!task) {
      return {
        allow: false,
        reasons: ['UNKNOWN_TASK'],
        remediation: [
          `Task ${taskNum} not found in tasksMeta. Verify task number and re-run initTasksMeta.`,
        ],
      };
    }

    // Check dependency readiness (R3)
    if (Array.isArray(task.dependencies) && task.dependencies.length > 0) {
      for (const depNum of task.dependencies) {
        const depId = `task_${depNum}`;
        const dep = tasksMeta.tasks.find((t) => t && t.id === depId);
        if (!dep || dep.status !== 'completed') {
          return {
            allow: false,
            reasons: ['DEPENDENCY_NOT_READY'],
            remediation: [
              `Task ${taskNum} depends on Task ${depNum} which is not completed (status: ${dep ? dep.status : 'missing'}).`,
              `Complete Task ${depNum} before starting Task ${taskNum}.`,
              'Use canStart(ticketId, taskNum) to check readiness before claiming.',
            ],
          };
        }
      }
    }

    return null;
  };
}

/**
 * Create a path intent check (R6).
 *
 * If filePath is provided, validates it against the allowed paths using
 * `isWriteAllowedPath`. If filePath is not provided, the check passes
 * (no path intent to validate).
 *
 * @param {object} params
 * @param {string} [params.filePath] - Absolute path being written
 * @param {object} [params.allowedPaths] - { prDir, taskDir, ticketRoot }
 * @returns {PreflightCheck}
 */
function createPathCheck(params) {
  const filePath = params && params.filePath;
  const allowedPaths = params && params.allowedPaths;

  return function pathCheck() {
    if (!filePath) return null;

    if (isWriteAllowedPath(filePath, allowedPaths)) return null;

    return {
      allow: false,
      reasons: ['PATH_NOT_ALLOWED'],
      remediation: [
        `Write to "${filePath}" is outside the allowed path set.`,
        'Allowed paths: PR{N}/ worktree, task${N}/ artifacts, and shared-root whitelist (brief.md, spec.md, tasks.md, .work-state.json, .work-actions.json).',
        'Verify the file path and ensure it falls under the claimed worker or task directory.',
      ],
    };
  };
}

module.exports = {
  runPreflight,
  isWriteAllowedPath,
  createGraphCheck,
  createClaimCheck,
  createPathCheck,
};
