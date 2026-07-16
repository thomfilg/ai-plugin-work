'use strict';

/**
 * task-verify/shadow.js — SHADOW-mode runner (GH-755; plan §6 Phase 2).
 *
 * When WORK_TDD_MODE=shadow, the implement gate calls maybeRunShadow() at
 * each task boundary: the verifier observes reality, evaluates, and logs its
 * verdict — with ZERO authority. The audit row records both the incumbent
 * gate outcome and the shadow verdict, so the per-ticket divergence report
 * is a jq over `.work-actions.json` (action == 'task-verify-shadow').
 *
 * Never throws into the gate: any internal failure is itself audited
 * (action 'task-verify-shadow-error') and swallowed.
 */

const path = require('path');

const { observeBoundary, resolveTaskBaseRef } = require('./boundary');
const { VERDICTS } = require('../lib/outcome-verdicts');

function shadowEnabled(env = process.env) {
  return env.WORK_TDD_MODE === 'shadow';
}

/** Incumbent vs shadow: who was stricter? */
function computeDivergence(incumbent, verdict) {
  const shadowBlocks = verdict === VERDICTS.contradicted;
  if (incumbent === 'advance' && shadowBlocks) return 'shadow-stricter';
  if (incumbent === 'blocked' && !shadowBlocks) return 'shadow-looser';
  return 'agree';
}

/**
 * Observe + evaluate + audit one boundary. Returns the shadow result, or
 * null when disabled/failed. `deps` is injectable for tests.
 */
function runShadowVerification(input, deps = {}) {
  const { safeName, tasksDir, taskNum, taskType, incumbent } = input;
  const repoDir = input.repoDir || process.cwd();
  const appendAudit =
    deps.appendAudit ||
    require(path.join(__dirname, '..', 'work', 'lib', 'work-actions')).appendEnforcementAudit;

  const boundary = observeBoundary({
    repoDir,
    tasksDir,
    taskNum,
    taskType,
    baseRef: input.baseRef,
    baseWorktreeDir: input.baseWorktreeDir,
  });
  if (boundary.error) {
    appendAudit(safeName, {
      origin: 'workflow',
      task: taskNum,
      phase: null,
      action: 'task-verify-shadow-error',
      allow: true,
      reason: boundary.error,
      outputPath: null,
    });
    return null;
  }
  const { observations, result } = boundary;

  appendAudit(safeName, {
    origin: 'workflow',
    task: taskNum,
    phase: null,
    action: 'task-verify-shadow',
    allow: true,
    reason: result.verdict,
    outputPath: null,
    meta: {
      kind: taskType,
      incumbent,
      verdict: result.verdict,
      violatedInvariants: result.violatedInvariants,
      flags: result.flags,
      exit: result.exit,
      reasons: result.reasons.slice(0, 5),
      divergence: computeDivergence(incumbent, result.verdict),
      derivedTests: observations.derivedTests,
    },
  });
  return result;
}

/**
 * Gate-facing entry point: no-op unless WORK_TDD_MODE=shadow; never throws.
 */
function maybeRunShadow(input, deps = {}) {
  if (!shadowEnabled(deps.env)) return null;
  try {
    return runShadowVerification(input, deps);
  } catch (err) {
    try {
      const appendAudit =
        deps.appendAudit ||
        require(path.join(__dirname, '..', 'work', 'lib', 'work-actions')).appendEnforcementAudit;
      appendAudit(input.safeName, {
        origin: 'workflow',
        task: input.taskNum,
        phase: null,
        action: 'task-verify-shadow-error',
        allow: true,
        reason: String(err && err.message).slice(0, 300),
        outputPath: null,
      });
    } catch {
      /* shadow must never break the gate */
    }
    return null;
  }
}

module.exports = {
  shadowEnabled,
  resolveTaskBaseRef,
  computeDivergence,
  runShadowVerification,
  maybeRunShadow,
};
