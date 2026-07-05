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
  require('../lib/instruction-guards').installInstructionGuards('check_instruction');
}

// ─── Resolve paths ──────────────────────────────────────────────────────────
const { resolvePluginConfig } = require('../lib/plugin-config');
const { libDir, TASKS_BASE } = resolvePluginConfig(path.join(__dirname, '..', 'work'));

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
const { acquireLock, releaseLock } = require(path.join(__dirname, 'lib', 'report-utils'));
const { assessTerminalState, recordCompletion } = require(path.join(__dirname, 'lib', 'staleness'));

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

// Atomic tmp + rename write. A plain writeFileSync truncates first, so a
// concurrent reader could see a 0-byte/partial state file, fail JSON.parse,
// re-init at 1_setup, and purge freshly-written *.check.md reports (GH-611).
function saveState(safeName, state) {
  const dir = path.join(TASKS_BASE, safeName);
  fs.mkdirSync(dir, { recursive: true });
  const target = stateFile(safeName);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, target);
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

// ─── SHA-gated terminal-state handling (GH-307, echo-5213-3, echo-5808-C) ──
// A complete/needs_work state is only honored while the changes hash (and
// recorded HEAD) still match the working tree. On drift the state is
// invalidated automatically — no manual --init / state-file surgery — and a
// fresh cycle starts (check-setup's cycle-marker purge clears stale reports
// because the hash changed). This is enforcement, not a bypass: a reset can
// only be produced by a real diff.
// Returns { state, result }: result is a final instruction, or null to fall
// through into the orchestrator loop with the (possibly reset) state.

function resetStaleCycle(safeName, state, assessment) {
  const previousCycle = {
    changesHash: state.completedChangesHash || state.changesHash || null,
    completedHeadSha: state.completedHeadSha || null,
    completedAt: state.completedAt || null,
    status: state.status,
    invalidatedAt: new Date().toISOString(),
    reason: assessment.reasons.join('; '),
  };
  const fresh = initState(safeName);
  fresh.previousCycle = previousCycle;
  saveState(safeName, fresh);
  // caller falls through — the loop starts the new cycle at 1_setup
  return { state: fresh, result: null };
}

function answerNeedsWork(safeName, state, assessment) {
  // Severity gate (echo-5804-004): never answer "Already complete" while
  // the latest reports at the CURRENT hash parse as NEEDS_WORK.
  state.status = 'needs_work';
  state.reportStatuses = assessment.reports;
  saveState(safeName, state);
  return {
    state,
    result: {
      type: 'check_instruction',
      action: 'needs_work',
      state: { ticket: safeName, currentStep: state.currentStep },
      reason:
        `Check is NOT complete: ${assessment.reasons.join('; ')}. ` +
        `Fix the reported issues and commit — the next /check2 run will detect the new ` +
        `changes hash and start a fresh cycle automatically.`,
      reports: assessment.reports,
    },
  };
}

function answerStillValid(safeName, state, assessment) {
  // Same hash, reports passing → genuinely still valid.
  saveState(safeName, state);
  return {
    state,
    result: {
      type: 'check_instruction',
      action: 'complete',
      summary: `Check still valid for ${safeName} (changes hash ${
        assessment.currentHash || state.changesHash || 'unknown'
      } unchanged, reports passing) — nothing to do.`,
    },
  };
}

function handleTerminalState(safeName, state, tasksDir, probes) {
  if (state.status !== 'complete' && state.status !== 'needs_work') {
    return { state, result: null };
  }
  const reportFolder = state.setupResult?.reportFolder || tasksDir;
  const assessment = assessTerminalState(state, reportFolder, probes);
  if (assessment.verdict === 'stale') return resetStaleCycle(safeName, state, assessment);
  if (assessment.verdict === 'needs_work') return answerNeedsWork(safeName, state, assessment);
  return answerStillValid(safeName, state, assessment);
}

function advanceOrComplete(safeName, state, stepIdx, probes) {
  const nextIdx = stepIdx + 1;
  if (nextIdx >= STEPS.length) {
    state.status = 'complete';
    recordCompletion(state, probes);
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
  return null;
}

function runOrchestratorLoop(safeName, state, ctx, probes) {
  for (let iterations = 0; iterations < MAX_ITERATIONS; iterations++) {
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
    const advanced = advanceOrComplete(safeName, state, stepIdx, probes);
    if (advanced) return advanced;
  }

  saveState(safeName, state);
  return { type: 'check_instruction', action: 'blocked', reason: 'Max iterations reached' };
}

function getNextInstruction(safeName, opts = {}) {
  const loaded = loadState(safeName) || initState(safeName);
  const tasksDir = path.join(TASKS_BASE, safeName);
  const ctx = { tasksDir, checkHooksDir, TASKS_BASE };
  const probes = opts.probes || {};

  const { state, result } = handleTerminalState(safeName, loaded, tasksDir, probes);
  if (result) return result;

  return runOrchestratorLoop(safeName, state, ctx, probes);
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
    const { ownerStamp } = require(path.join(__dirname, '..', 'work', 'lib', 'marker'));
    const markerDir = path.join(TASKS_BASE, safeName);
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(
      path.join(markerDir, '.check2-orchestrator.pid'),
      JSON.stringify({
        ticket: safeName,
        startedAt: new Date().toISOString(),
        workflow: '/check2',
        ...ownerStamp(),
      })
    );
  }

  // Serialize step execution: the PostToolUse auto-advance hook and a manual
  // check-next.js invocation must not interleave (GH-611). Losing the race is
  // benign — the holder will emit the next instruction; we just report and
  // exit (action 'locked' has no banner in the hook, so it stays silent).
  const lockPath = path.join(TASKS_BASE, safeName, '.check2-next.lock');
  if (!acquireLock(lockPath)) {
    console.log(
      JSON.stringify(
        {
          type: 'check_instruction',
          action: 'locked',
          reason: `Another check-next.js invocation is already running for ${safeName}. Wait for it to finish, then re-run.`,
        },
        null,
        2
      )
    );
    return;
  }

  let instruction;
  try {
    instruction = getNextInstruction(safeName);
  } finally {
    releaseLock(lockPath);
  }
  console.log(JSON.stringify(instruction, null, 2));
}

if (require.main === module) main();

module.exports = { getNextInstruction };
