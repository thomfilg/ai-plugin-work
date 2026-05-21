#!/usr/bin/env node

/**
 * check-next.js — Script-driven orchestrator for /check2.
 *
 * Outputs a SINGLE instruction. Auto-advance hook calls this after each step.
 *
 * IMPORTANT: No step-specific logic here. Steps live in lib/steps/.
 *
 * Usage: node check-next.js <TICKET_ID> [--init]
 */

'use strict';

const fs = require('fs');
const path = require('path');

if (require.main === module) {
  process.on('uncaughtException', (err) => {
    console.error(
      JSON.stringify({
        type: 'check_instruction',
        action: 'blocked',
        reason: `Uncaught exception: ${err.message}`,
        stack: err.stack,
      })
    );
    process.exit(1);
  });
  process.on('unhandledRejection', (err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        type: 'check_instruction',
        action: 'blocked',
        reason: `Unhandled rejection: ${msg}`,
      })
    );
    process.exit(1);
  });
}

// ─── Resolve paths ──────────────────────────────────────────────────────────
const { resolvePluginPaths } = require(
  path.join(__dirname, '..', 'work-orchestrator', 'lib', 'resolve-plugin-root')
);
const { workDir, libDir } = resolvePluginPaths(path.join(__dirname, '..', 'work-orchestrator'), 2);
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

// Ticket provider for ID sanitization (#279 → GH-279)
let tp;
try {
  tp = require(path.join(libDir, 'ticket-provider'));
} catch {
  console.log(
    JSON.stringify({
      type: 'check_instruction',
      action: 'blocked',
      reason: 'ticket-provider not found',
    })
  );
  process.exit(0);
}

// ─── Step registry ──────────────────────────────────────────────────────────
const { runStep, STEPS } = require(path.join(__dirname, 'lib', 'step-registry'));

const checkHooksDir = path.join(__dirname, '..', 'check', 'hooks');

// ─── State management ───────────────────────────────────────────────────────

function stateFile(safeName) {
  return path.join(TASKS_BASE, safeName, '.check2-state.json');
}

function loadState(safeName) {
  try {
    return JSON.parse(fs.readFileSync(stateFile(safeName), 'utf8'));
  } catch {
    return null;
  }
}

function saveState(safeName, state) {
  const dir = path.join(TASKS_BASE, safeName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFile(safeName), JSON.stringify(state, null, 2));
}

function initState(safeName) {
  return {
    ticketId: safeName,
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

const MAX_ITERATIONS = 20;

function getNextInstruction(safeName) {
  let state = loadState(safeName) || initState(safeName);
  const tasksDir = path.join(TASKS_BASE, safeName);
  const ctx = { tasksDir, checkHooksDir, TASKS_BASE };

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const stepIdx = STEPS.indexOf(state.currentStep);
    if (stepIdx < 0 || state.status === 'complete') {
      saveState(safeName, state);
      return { type: 'check_instruction', action: 'complete', summary: 'Already complete.' };
    }

    const result = runStep(state.currentStep, state, ctx);

    if (result) {
      saveState(safeName, state);
      return result;
    }

    // null → advance
    const nextIdx = stepIdx + 1;
    if (nextIdx >= STEPS.length) {
      state.status = 'complete';
      saveState(safeName, state);
      return {
        type: 'check_instruction',
        action: 'complete',
        summary: `Check complete for ${safeName}.`,
      };
    }

    state.currentStep = STEPS[nextIdx];
    state.dispatched = null;
    saveState(safeName, state);
  }

  saveState(safeName, state);
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

  const ticketRaw = args.filter((a) => !a.startsWith('--'))[0];
  const isInit = args.includes('--init');

  // Sanitize ticket ID: #279 → GH-279, PROJ-123 → PROJ-123
  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  const safeName = tp.sanitizeTicketIdForPath(ticketRaw, providerConfig);

  if (isInit) {
    const markerDir = path.join(TASKS_BASE, safeName);
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(
      path.join(markerDir, '.check2-orchestrator.pid'),
      JSON.stringify({ ticket: safeName, startedAt: new Date().toISOString(), workflow: '/check2' })
    );
  }

  const instruction = getNextInstruction(safeName);
  console.log(JSON.stringify(instruction, null, 2));
}

if (require.main === module) main();

module.exports = { getNextInstruction };
