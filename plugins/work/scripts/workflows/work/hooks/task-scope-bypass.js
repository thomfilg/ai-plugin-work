/**
 * task-scope-bypass.js
 *
 * Escape-hatch evaluation + audit writers for the protect-task-scope hook
 * (Gate D). Two hatches exist (GH-392 Task 8 + follow-up):
 *
 *   1. The one-shot env-var pair (REASON + TARGET), gated by
 *      WORK_OPERATOR_TOKEN (GH-528 round-2 ITEM 1) — see evaluateScopeBypass.
 *   2. `### Cross-Task Dependencies` allow-list — see crossTaskDepAllows.
 *
 * Every fired or rejected hatch appends an enforcement audit row so an
 * operator can see it without trusting caller-supplied state.
 */

'use strict';

const path = require('path');

const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));
const { findMatch } = require(
  path.join(__dirname, '..', '..', 'lib', 'hooks', 'policies', 'scope-protection')
);
const { appendEnforcementAudit } = require(
  path.join(__dirname, '..', '..', 'work', 'lib', 'work-actions')
);

// GH-528 round-2 ITEM 1: WORK_OPERATOR_TOKEN gate on env-bypass.
// Centralised so all three bypass call sites stay in lockstep.
function isOperatorTokenPresent() {
  return process.env.WORK_OPERATOR_TOKEN === '1';
}

/** Append an enforcement audit row; log (never throw) on failure. */
function appendAuditSafe(ticketId, row) {
  try {
    appendEnforcementAudit(ticketId, row);
  } catch (err) {
    try {
      logHookError(__filename, err);
    } catch {
      /* swallow */
    }
  }
}

/**
 * Append a `scope-bypass-rejected` audit row recording that the env-var pair
 * matched the write target but WORK_OPERATOR_TOKEN was missing. We log this
 * regardless of guard so an operator can see every rejected attempt across
 * the three layers.
 */
function auditScopeBypassRejected({
  ticketId,
  active,
  relTarget,
  bypassReason,
  bypassTargetCfg,
  guard,
}) {
  appendAuditSafe(ticketId, {
    origin: 'ai-subtask',
    task: active.taskNum,
    phase: null,
    action: 'scope-bypass-rejected',
    allow: false,
    reason: bypassReason,
    outputPath: relTarget,
    meta: {
      taskNum: active.taskNum,
      target: relTarget,
      configuredTarget: bypassTargetCfg,
      guard,
      rejectReason: 'WORK_OPERATOR_TOKEN missing',
    },
  });
}

/**
 * Append a `scope-bypass` (allow) audit row so a fired escape hatch is never
 * silent. `guard` discriminates the layer in meta and is omitted for the
 * base files-in-scope layer (its historical rows carry no guard key).
 */
function auditScopeBypassAllowed({
  ticketId,
  active,
  relTarget,
  bypassReason,
  bypassTargetCfg,
  guard,
}) {
  const meta = { taskNum: active.taskNum, target: relTarget, configuredTarget: bypassTargetCfg };
  if (guard) meta.guard = guard;
  appendAuditSafe(ticketId, {
    origin: 'ai-subtask',
    task: active.taskNum,
    phase: null,
    action: 'scope-bypass',
    allow: true,
    reason: bypassReason,
    outputPath: relTarget,
    meta,
  });
}

/**
 * GH-392 Task 8 / spec §P0#6 + GH-528 ITEM 1: shared env-var escape hatch.
 *
 * BOTH `PROTECT_TASK_SCOPE_BYPASS_REASON` and `PROTECT_TASK_SCOPE_BYPASS_TARGET`
 * must be set, and the relativized write target must match `BYPASS_TARGET`
 * (exact match OR via the same findMatch glob logic). REASON alone is NOT
 * enough — that originally opened a hole for any path in any tool call while
 * the var was set. Pinning to TARGET makes the bypass one-shot: the operator
 * declares exactly which file they intend to touch.
 *
 * Returns:
 *   'allowed'   — pair matched + operator token present (audited)
 *   'rejected'  — pair matched but WORK_OPERATOR_TOKEN missing (audited;
 *                 the caller keeps its block)
 *   'no-bypass' — pair unset or target mismatch. NO audit row: a mis-
 *                 targeted bypass is indistinguishable from a typo and we
 *                 don't want to log noise for unintentional uses.
 *
 * `guard` labels the rejected row; `allowGuard` (optional) labels the allowed
 * row's meta — the base scope layer passes none to keep its historical shape.
 */
function readBypassEnvPair() {
  return {
    bypassReason: (process.env.PROTECT_TASK_SCOPE_BYPASS_REASON || '').trim(),
    bypassTargetCfg: (process.env.PROTECT_TASK_SCOPE_BYPASS_TARGET || '').trim(),
  };
}

function bypassTargetMatches(relTarget, bypassTargetCfg) {
  return relTarget === bypassTargetCfg || findMatch(relTarget, [bypassTargetCfg]) !== null;
}

function evaluateScopeBypass({ ticketId, active, relTarget, guard, allowGuard }) {
  const { bypassReason, bypassTargetCfg } = readBypassEnvPair();
  if (!bypassReason || !bypassTargetCfg || !relTarget) return 'no-bypass';
  if (!bypassTargetMatches(relTarget, bypassTargetCfg)) return 'no-bypass';
  if (!isOperatorTokenPresent()) {
    if (ticketId) {
      auditScopeBypassRejected({
        ticketId,
        active,
        relTarget,
        bypassReason,
        bypassTargetCfg,
        guard,
      });
    }
    return 'rejected';
  }
  if (ticketId) {
    auditScopeBypassAllowed({
      ticketId,
      active,
      relTarget,
      bypassReason,
      bypassTargetCfg,
      guard: allowGuard,
    });
  }
  return 'allowed';
}

/**
 * GH-392 Task 8 / spec §P0#7b: cross-task allow-list. If the would-be-
 * blocked target matches an entry in `active.crossTaskDeps`, audit it and
 * report true so the caller exits 0.
 */
function crossTaskDepAllows(ticketId, active, relTarget) {
  const deps = active.crossTaskDeps;
  if (!relTarget || !Array.isArray(deps) || deps.length === 0) return false;
  if (!findMatch(relTarget, deps)) return false;
  appendAuditSafe(ticketId, {
    origin: 'ai-subtask',
    task: active.taskNum,
    phase: null,
    action: 'cross-task-dep-allow',
    allow: true,
    reason: 'matched ### Cross-Task Dependencies',
    outputPath: relTarget,
    meta: { taskNum: active.taskNum, target: relTarget },
  });
  return true;
}

module.exports = { evaluateScopeBypass, crossTaskDepAllows };
