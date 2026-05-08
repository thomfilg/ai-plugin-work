#!/usr/bin/env node

/**
 * check-next.js — Script-driven orchestrator for /check2.
 *
 * Outputs a SINGLE instruction — the next thing the AI should do.
 * A PostToolUse hook (check-auto-advance.js) calls this after each step
 * completes, creating an automatic advance loop.
 *
 * IMPORTANT: This file is the generic orchestrator. NO step-specific logic here.
 * Step-specific behavior lives in lib/steps/ — registered via the step registry.
 *
 * Usage: node check-next.js <TICKET_ID> [--init]
 */

'use strict';

const fs = require('fs');
const path = require('path');

// Fail-safe
if (require.main === module) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
}

// ─── Resolve paths ──────────────────────────────────────────────────────────
const { resolvePluginPaths } = require(
  path.join(__dirname, '..', 'work2', 'lib', 'resolve-plugin-root')
);
const { libDir } = resolvePluginPaths(path.join(__dirname, '..', 'work2'), 2);
const getConfig = require(path.join(libDir, 'get-config'));

const WORKTREES_BASE = getConfig('WORKTREES_BASE') || '';
const TASKS_BASE =
  getConfig('TASKS_BASE') || (WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '');

if (!TASKS_BASE) {
  console.log(
    JSON.stringify({
      type: 'check_instruction',
      action: 'blocked',
      reason: 'TASKS_BASE not configured',
    })
  );
  process.exit(0);
}

// ─── Step registry ──────────────────────────────────────────────────────────
const { runStep, STEPS } = require(path.join(__dirname, 'lib', 'step-registry'));

// Check hooks from /check (reused)
const checkHooksDir = path.join(__dirname, '..', 'check', 'hooks');

// ─── State management ───────────────────────────────────────────────────────

function stateFile(ticketId) {
  return path.join(TASKS_BASE, ticketId, '.check2-state.json');
}

function loadState(ticketId) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(ticketId), 'utf8'));
  } catch {
    return null;
  }
}

function saveState(ticketId, state) {
  const dir = path.join(TASKS_BASE, ticketId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile(ticketId), JSON.stringify(state, null, 2));
}

function initState(ticketId) {
  return {
    ticketId,
    currentStep: STEPS[0],
    status: 'in_progress',
    dispatched: null,
    changesHash: null,
    setupResult: null,
    consensusIteration: 0,
    startTime: new Date().toISOString(),
  };
}

// ─── Core orchestrator loop ─────────────────────────────────────────────────
// Walks through STEPS in order. For each step, calls the registered handler.
// If handler returns null → advance to next step (loop continues).
// If handler returns an instruction → return it to the AI (loop stops).

const MAX_ITERATIONS = 20; // safety: prevent infinite loops

function getNextInstruction(ticketId) {
  let state = loadState(ticketId) || initState(ticketId);
  const tasksDir = path.join(TASKS_BASE, ticketId);
  const ctx = { tasksDir, checkHooksDir, TASKS_BASE };

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const stepIdx = STEPS.indexOf(state.currentStep);
    if (stepIdx < 0 || state.status === 'complete') {
      saveState(ticketId, state);
      return { type: 'check_instruction', action: 'complete', summary: 'Already complete.' };
    }

    // Run the step handler
    const result = runStep(state.currentStep, state, ctx);

    if (result) {
      // Step returned an instruction — save state and return to AI
      saveState(ticketId, state);
      return result;
    }

    // null → step is done, advance to next
    const nextIdx = stepIdx + 1;
    if (nextIdx >= STEPS.length) {
      state.status = 'complete';
      saveState(ticketId, state);
      return {
        type: 'check_instruction',
        action: 'complete',
        summary: `Check complete for ${ticketId}.`,
      };
    }

    state.currentStep = STEPS[nextIdx];
    state.dispatched = null;
    saveState(ticketId, state);
    // Loop continues to the next step
  }

  // Safety: should never reach here
  saveState(ticketId, state);
  return { type: 'check_instruction', action: 'blocked', reason: 'Max iterations reached' };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(
      JSON.stringify({
        type: 'check_instruction',
        action: 'blocked',
        reason: 'No ticket ID provided',
      })
    );
    process.exit(0);
  }

  const ticketId = args.filter((a) => !a.startsWith('--'))[0];
  const isInit = args.includes('--init');

  if (isInit) {
    // Write marker for auto-advance hook
    const markerDir = path.join(TASKS_BASE, ticketId);
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(
      path.join(markerDir, '.check2-orchestrator.pid'),
      JSON.stringify({ ticket: ticketId, startedAt: new Date().toISOString(), workflow: '/check2' })
    );
  }

  const instruction = getNextInstruction(ticketId);
  console.log(JSON.stringify(instruction, null, 2));
}

if (require.main === module) main();

module.exports = { getNextInstruction };
