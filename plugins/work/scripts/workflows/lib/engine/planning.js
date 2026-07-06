'use strict';

/**
 * lib/engine/planning.js — plan generation + formatting for the workflow
 * engine (extracted from workflow-engine.js).
 */

const path = require('path');

// The CLI entry the TRANSITION hint points at (workflow-engine.js).
const ENGINE_FILE = path.join(__dirname, '..', 'workflow-engine.js');

/** Run the workflow's detectStepState() for one step (fail-soft). */
function detectStepAction(workflow, step, instanceId, existingState, inspectData) {
  const fallback = { action: 'RUN', reason: step.name, command: step.command || null };
  try {
    const detection = workflow.detectStepState(step.id, instanceId, existingState, inspectData);
    if (!detection) return fallback;
    return {
      action: detection.action || fallback.action,
      reason: detection.reason || fallback.reason,
      command: detection.command !== undefined ? detection.command : fallback.command,
    };
  } catch (err) {
    return { ...fallback, reason: `detectStepState error: ${err.message}` };
  }
}

/**
 * Generate a plan using the workflow's detectStepState() for each step.
 * Falls back to PENDING for all steps if detectStepState is not provided.
 */
function defaultPlanGenerator(workflow, instanceId, args, stateInstance) {
  const existingState = stateInstance.load(instanceId);
  const inspectData = workflow.inspect ? workflow.inspect(instanceId) : {};

  const plan = [];
  for (const step of workflow.steps) {
    let detected = { action: 'RUN', reason: step.name, command: step.command || null };
    if (workflow.detectStepState) {
      detected = detectStepAction(workflow, step, instanceId, existingState, inspectData);
    } else if (existingState?.stepStatus?.[step.id] === 'completed') {
      detected = { ...detected, action: 'SKIP', reason: 'Previously completed' };
    }

    plan.push({
      step: step.id,
      name: step.name,
      action: detected.action,
      ...(detected.command ? { command: detected.command } : {}),
      reason: detected.reason,
    });
  }

  return plan;
}

/**
 * Resolve a `status: completed` instance before planning (GH-307).
 *
 * When the workflow provides `completedStaleCheck(instanceId, state)` and the
 * prior instance is completed:
 *   - stale (a SHA condition proves the inputs changed) → the old state is
 *     ARCHIVED (not deleted) with the drift reason, and planning proceeds
 *     from a fresh instance. This is SHA-gated enforcement — a reset can
 *     only be produced by a real diff, so it is not a bypass path.
 *   - not stale → the completed state is kept and the caller reports
 *     "still valid, nothing to do".
 *
 * @returns {null | {reset: boolean, reasons: string[], archivedTo?: string|null, message?: string}}
 */
function resolveCompletedState(workflow, stateInstance, instanceId) {
  if (typeof workflow.completedStaleCheck !== 'function') return null;
  const existing = stateInstance.load(instanceId);
  if (!existing || existing.status !== 'completed') return null;

  let verdict;
  try {
    verdict = workflow.completedStaleCheck(instanceId, existing);
  } catch (err) {
    // Fail-safe: cannot prove drift → keep the completed state.
    return {
      reset: false,
      reasons: [],
      message: `completedStaleCheck failed (${err.message}) — keeping completed state`,
    };
  }

  if (verdict && verdict.stale) {
    const archivedTo = stateInstance.archive(instanceId, verdict.reasons.join('; '));
    return { reset: true, reasons: verdict.reasons, archivedTo };
  }

  return {
    reset: false,
    reasons: verdict?.reasons || [],
    message:
      'Workflow already completed and all SHAs match the current working tree — nothing to re-run.',
  };
}

// Per-action plan icons (fallback: hourglass for PENDING/unknown).
const ACTION_ICONS = {
  RUN: '🔄',
  SKIP: '⏭️',
  DEFER: '🔮',
  BLOCKED: '🛑',
};

function formatSummaryLines(summary) {
  const lines = [];
  lines.push(
    `  SUMMARY: ${summary.run} RUN, ${summary.blocked || 0} BLOCKED, ${summary.defer || 0} DEFER, ${summary.skip} SKIP, ${summary.pending} PENDING`
  );
  if (summary.firstAction !== 'none') {
    lines.push(`  FIRST ACTION: ${summary.firstAction}`);
  }
  if (summary.stepsToRun.length > 0) {
    lines.push(`  STEPS TO RUN: ${summary.stepsToRun.join(' → ')}`);
  }
  if (summary.stepsDeferred && summary.stepsDeferred.length > 0) {
    lines.push(`  STEPS DEFERRED: ${summary.stepsDeferred.join(' → ')}`);
  }
  if (summary.stepsBlocked && summary.stepsBlocked.length > 0) {
    lines.push(`  STEPS BLOCKED: ${summary.stepsBlocked.join(' → ')}`);
  }
  return lines;
}

/** Render one plan row: icon, padded step + action, reason, optional command. */
function formatPlanRow(step) {
  const icon = ACTION_ICONS[step.action] || '⏳';
  const suffix = step.command ? ` → ${step.command}` : '';
  return `    ${icon} ${step.step.padEnd(20)} ${step.action.padEnd(7)} ${step.reason}${suffix}`;
}

function defaultFormatPlan(workflow, instanceId, plan, summary) {
  const rule = '═'.repeat(67);
  const lines = [
    '',
    rule,
    `  WORKFLOW PLAN: ${workflow.name} (${instanceId})`,
    rule,
    '',
    '  PLAN:',
  ];
  lines.push(...plan.map(formatPlanRow));

  lines.push('');
  lines.push(...formatSummaryLines(summary));
  lines.push('');
  lines.push(rule);
  lines.push(
    '  INSTRUCTIONS: Execute RUN steps in order. DEFER steps: re-run plan first to resolve to RUN/SKIP.'
  );
  lines.push(`  TRANSITION: node ${ENGINE_FILE} ${workflow.name} transition ${instanceId} <step>`);
  lines.push(rule);
  lines.push('');

  return lines.join('\n');
}

/** Count plan actions and derive the first actionable step. */
function buildPlanSummary(plan) {
  const byAction = (a) => plan.filter((s) => s.action === a);
  return {
    total: plan.length,
    run: byAction('RUN').length,
    skip: byAction('SKIP').length,
    defer: byAction('DEFER').length,
    pending: byAction('PENDING').length,
    blocked: byAction('BLOCKED').length,
    // firstAction: BLOCKED takes priority (must resolve before proceeding), then RUN, then DEFER
    firstAction:
      byAction('BLOCKED')[0]?.step ||
      byAction('RUN')[0]?.step ||
      byAction('DEFER')[0]?.step ||
      'none',
    stepsToRun: byAction('RUN').map((s) => s.step),
    stepsDeferred: byAction('DEFER').map((s) => s.step),
    stepsSkipped: byAction('SKIP').map((s) => s.step),
    stepsBlocked: byAction('BLOCKED').map((s) => s.step), // rendered with stop sign icon in formatPlan
  };
}

module.exports = {
  defaultPlanGenerator,
  resolveCompletedState,
  defaultFormatPlan,
  buildPlanSummary,
};
