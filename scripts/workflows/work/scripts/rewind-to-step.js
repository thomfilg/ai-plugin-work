#!/usr/bin/env node

/**
 * rewind-to-step.js
 *
 * Orchestrator-only rewind: move a ticket's workflow back to an earlier step
 * by setting the target step to in_progress and resetting all later steps to
 * pending. Required when a step (e.g. follow_up, ci) was marked completed
 * without actually performing its verification — see the ECHO-4451 case.
 *
 * Why this lives here: direct edits to .work-state.json are blocked by the
 * orchestrator-state protection hook for good reason. This script provides a
 * single, auditable, intentional rewind path that lives in a trusted dir and
 * fails-closed on malformed input.
 *
 * Usage:
 *   node rewind-to-step.js <TICKET_ID> <TARGET_STEP>
 *
 * Constraints:
 *   - TARGET_STEP must be a known step from step-registry STEP_ORDER.
 *   - TARGET_STEP index must be < currentStep index (no forward rewind).
 *   - Steps before TARGET_STEP are left untouched (typically completed).
 *   - TARGET_STEP and everything after are reset:
 *       TARGET_STEP -> in_progress
 *       later steps -> pending
 *   - status is set to in_progress; completedTime is cleared if present.
 *   - Dispatched markers cleared so the workflow re-dispatches the step.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { STEPS: _STEPS, STEP_ORDER } = require('../step-registry');
const config = require('../../lib/config');

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

const [, , ticketIdArg, targetStep] = process.argv;

if (!ticketIdArg || !targetStep) {
  fail('Usage: node rewind-to-step.js <TICKET_ID> <TARGET_STEP>');
}

if (!STEP_ORDER.includes(targetStep)) {
  fail(`Unknown step '${targetStep}'. Valid: ${STEP_ORDER.join(', ')}`);
}

const tasksDir = config.tasksDir(ticketIdArg);
if (!tasksDir) {
  fail('TASKS_BASE not configured (set via env or .envrc)');
}
const statePath = path.join(tasksDir, '.work-state.json');

if (!fs.existsSync(statePath)) {
  fail(`State file not found: ${statePath}`);
}

const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));

const targetIdx = STEP_ORDER.indexOf(targetStep);
const currentIdx =
  typeof state.currentStep === 'number' ? state.currentStep : STEP_ORDER.indexOf(state.currentStep);

if (currentIdx >= 0 && targetIdx >= currentIdx) {
  fail(
    `Refusing to rewind: target '${targetStep}' (idx ${targetIdx}) is not earlier than current step (idx ${currentIdx}). Use the regular forward transition mechanism instead.`
  );
}

state.currentStep = targetIdx;
state.status = 'in_progress';
for (let i = 0; i < STEP_ORDER.length; i++) {
  const stepName = STEP_ORDER[i];
  if (i < targetIdx) continue;
  if (i === targetIdx) {
    state.stepStatus[stepName] = 'in_progress';
  } else {
    state.stepStatus[stepName] = 'pending';
  }
}

delete state._work2Dispatched;
delete state._work2DispatchedAction;
delete state.completedTime;
state.lastUpdate = new Date().toISOString();

fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');

process.stdout.write(
  JSON.stringify(
    {
      ok: true,
      ticket: ticketIdArg,
      rewoundTo: targetStep,
      currentStep: targetIdx,
    },
    null,
    2
  ) + '\n'
);
