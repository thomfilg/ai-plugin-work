'use strict';

/**
 * task-verify/outcome-gate.js — the OUTCOME-mode boundary gate (GH-756;
 * plan §5.1). Active only when WORK_TDD_MODE=outcome.
 *
 * Task advance is decided by the verifier verdict:
 *   VERIFIED / UNVERIFIED  → advance; flags are recorded on the work state
 *                            (`outcomeFlags`) for task_review and the check
 *                            step (which hard-fails on unresolved flags).
 *   CONTRADICTED           → typed exit through the EXISTING recovery edges:
 *                            `retry` persists the contradiction as retry
 *                            guidance (surfaced in the next dispatch prompt);
 *                            `reopen-artifact` parks the planner hold
 *                            (tasks.md editable); `escalate` remains the
 *                            operator's `work-state.js recover`.
 *
 * A verifier-internal failure is a MECHANISM failure: advance with a
 * `runner-unknown` flag (absence of evidence never blocks) and an error
 * audit row. Every boundary decision is audited (`action: task-verify`).
 */

const path = require('path');

const { VERDICTS, FLAG_KINDS } = require('../lib/outcome-verdicts');
const { observeBoundary } = require('./boundary');

function appendAuditSafe(safeName, entry) {
  try {
    const { appendEnforcementAudit } = require(
      path.join(__dirname, '..', 'work', 'lib', 'work-actions')
    );
    appendEnforcementAudit(safeName, entry);
  } catch {
    /* audit is best-effort */
  }
}

/** Upsert this task's flag record on the work state (resolution = re-verify). */
function recordOutcomeFlags(ws, taskNum, verdict, flags) {
  const entries = Array.isArray(ws.outcomeFlags) ? ws.outcomeFlags : [];
  const kept = entries.filter((e) => e && e.task !== taskNum);
  if (flags.length > 0) {
    kept.push({ task: taskNum, verdict, flags, at: new Date().toISOString() });
  }
  ws.outcomeFlags = kept;
}

/**
 * Run the outcome gate for one boundary.
 *
 * @param {object} input - { safeName, ws, tasksDir, taskNum, taskType,
 *   saveWorkState, recordRetry, repoDir? }
 * @returns {{ advance: true, verdict: string, flags: string[] }
 *         | { blocked: 'retry'|'reopen-artifact', reasons: string[] }}
 */
function runOutcomeGate(input, deps = {}) {
  const { safeName, ws, tasksDir, taskNum, taskType, saveWorkState, recordRetry } = input;
  const repoDir = input.repoDir || process.cwd();
  const observe = deps.observe || observeBoundary;

  let boundary;
  try {
    boundary = observe({ repoDir, tasksDir, taskNum, taskType });
  } catch (err) {
    boundary = { error: String(err && err.message) };
  }

  if (boundary.error) {
    // Mechanism failure — advance with a flag, never block on it.
    recordOutcomeFlags(ws, taskNum, VERDICTS.unverified, [FLAG_KINDS.runnerUnknown]);
    saveWorkState(safeName, ws);
    appendAuditSafe(safeName, {
      origin: 'workflow',
      task: taskNum,
      phase: null,
      action: 'task-verify-error',
      allow: true,
      reason: boundary.error.slice(0, 300),
      outputPath: null,
    });
    return { advance: true, verdict: VERDICTS.unverified, flags: [FLAG_KINDS.runnerUnknown] };
  }

  const { result, observations } = boundary;
  appendAuditSafe(safeName, {
    origin: 'workflow',
    task: taskNum,
    phase: null,
    action: 'task-verify',
    allow: result.verdict !== VERDICTS.contradicted,
    reason: result.verdict,
    outputPath: null,
    meta: {
      kind: taskType,
      verdict: result.verdict,
      violatedInvariants: result.violatedInvariants,
      flags: result.flags,
      exit: result.exit,
      reasons: result.reasons.slice(0, 5),
      derivedTests: observations.derivedTests,
    },
  });

  if (result.verdict === VERDICTS.contradicted) {
    const reason =
      `outcome verifier: CONTRADICTED (${result.violatedInvariants.join(', ')}) — ` +
      result.reasons.join('; ');
    // reopen-artifact rides the existing planner-hold edge (defectKind set);
    // retry rides the existing retry-guidance edge (next dispatch prompt).
    const extras = result.exit === 'reopen-artifact' ? { defectKind: 'outcome-contradiction' } : {};
    recordRetry(reason, extras);
    return { blocked: result.exit, reasons: result.reasons };
  }

  recordOutcomeFlags(ws, taskNum, result.verdict, result.flags);
  saveWorkState(safeName, ws);
  return { advance: true, verdict: result.verdict, flags: result.flags };
}

module.exports = { runOutcomeGate, recordOutcomeFlags };
