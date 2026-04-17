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

module.exports = { runPreflight };
