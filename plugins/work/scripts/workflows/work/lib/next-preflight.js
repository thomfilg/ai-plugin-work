'use strict';

/**
 * next-preflight.js — pre-loop phases of the work-next orchestration cycle.
 *
 * Everything getNextInstruction does BEFORE iterating the plan lives here:
 * ticket validation/normalization, session-guard sync, DEFER-metadata
 * persistence, and the two terminal short-circuits (state already completed;
 * PR merged with ci-phase done).
 *
 * All helpers take the orchestrator environment (`env`) built by
 * work-next.js — no module-level configuration.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const { normalizeTicketBase } = require('./session-conflict');
const { stampVersionAnchor } = require('./version-skew');

function emptyProgressState(ticket) {
  return {
    ticket,
    currentStep: null,
    progress: '0/0',
    completedSteps: [],
    remainingSteps: [],
  };
}

function blockedInstruction(ticket, reason, suggestion) {
  return {
    type: 'work_instruction',
    action: 'blocked',
    state: emptyProgressState(ticket),
    reason,
    suggestion,
  };
}

/**
 * Parse + STRICT validate ticket input BEFORE any filesystem side effect.
 * This rejects malformed input like "ECHO-4446 TASKS" (whitespace), traversal,
 * or non-canonical bases — preventing creation of bogus tasks/ subfolders.
 */
function resolveTicket(env, ticketRaw) {
  const providerConfig = env.tp.getProviderConfig({ skipPrompt: true });
  let validated;
  try {
    validated = env.validateRawTicketInput(ticketRaw, providerConfig);
  } catch (err) {
    return {
      blocked: blockedInstruction(
        ticketRaw,
        err.message,
        'Pass a canonical ticket ID like PROJ-123 (or PROJ-123-suffix). No spaces or path separators.'
      ),
    };
  }
  const isGitHub = providerConfig?.provider === 'github';
  const ticket = normalizeTicketBase(validated.ticketBase, providerConfig);
  const isTicket = /^[A-Z]+-\d+$/i.test(ticket) || (/^#\d+$/.test(ticket) && isGitHub);
  return {
    ticket,
    suffix: validated.suffix,
    separator: validated.separator || null,
    isTicket,
    providerConfig,
  };
}

/** Override session guard workflow field (and fix cwd to the worktree). */
function syncSessionGuardFile(env, safeBase) {
  if (process.env.SESSION_GUARD_ENABLED === '0') return;
  try {
    const sessionDir = process.env.SESSION_GUARD_DIR || require('os').tmpdir();
    const sanitizedId = String(safeBase).replace(/[/\\:\0]/g, '_');
    const sessionPath = path.join(sessionDir, `claude-session-guard-${sanitizedId}.json`);
    if (fs.existsSync(sessionPath)) {
      const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      session.workflow = '/work';
      // Fix cwd to point to the worktree (not the calling cwd)
      session.cwd = path.join(env.WORKTREES_BASE, `${env.MAIN_WORKTREE_FOLDER}-${safeBase}`);
      fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
    }
  } catch {
    /* fail-open */
  }
}

/**
 * Backfill canonical identity on existing state from pre-this-fix sessions.
 * Uses the separator the user actually typed (validateRawTicketInput returns
 * '-', '/', or null). Falling back to '/' only when a suffix exists but the
 * parser didn't report a separator — defensive only.
 */
function backfillTicketIdentity(planState, meta) {
  if (planState.ticketBase === undefined) planState.ticketBase = meta.safeBase;
  if (planState.ticketSuffix === undefined) planState.ticketSuffix = meta.suffix || null;
  if (planState.ticketSeparator === undefined) {
    planState.ticketSeparator = meta.suffix ? meta.separator || '/' : null;
  }
}

function buildInitialDeferState(env, meta, deferredSteps, timestamp) {
  const ws = {
    ticketId: meta.safeName,
    ticketBase: meta.safeBase,
    ticketSuffix: meta.suffix || null,
    ticketSeparator: meta.suffix ? meta.separator || '/' : null,
    description: '',
    currentStep: 1,
    status: 'in_progress',
    stepStatus: Object.fromEntries(env.ALL_STEPS.map((s) => [s, 'pending'])),
    checkProgress: {},
    errors: [],
    startTime: new Date().toISOString(),
    lastPlanTimestamp: timestamp,
    deferredSteps,
  };
  stampVersionAnchor(ws);
  return ws;
}

/**
 * Persist DEFER metadata. Also persist the canonical ticket identity
 * (ticketBase / ticketSuffix / ticketSeparator) so future invocations can
 * verify they're addressing the same session even if the user passes a
 * shortened or different variant.
 */
function persistPlanMetadata(env, meta) {
  const { result, safeName } = meta;
  result.timestamp = new Date().toISOString();
  const deferredSteps = result.plan.filter((s) => s.action === 'DEFER').map((s) => s.step);
  const planState = env.loadWorkState(safeName);
  if (planState) {
    planState.lastPlanTimestamp = result.timestamp;
    planState.deferredSteps = deferredSteps;
    backfillTicketIdentity(planState, meta);
    env.saveWorkState(safeName, planState);
    return;
  }
  if (deferredSteps.length === 0) return;
  env.saveWorkState(safeName, buildInitialDeferState(env, meta, deferredSteps, result.timestamp));
  env.appendAction(safeName, { step: env.STEPS.ticket, what: 'workflow started (work)' });
}

/** Release session guard inline (best-effort). */
function releaseSessionGuard(env, safeName) {
  try {
    const sgPath = path.join(env.workDir, '..', 'lib', 'hooks', 'session-guard.js');
    execFileSync(process.execPath, [sgPath, 'finish', safeName], {
      encoding: 'utf8',
      timeout: 10000,
      stdio: 'pipe',
    });
  } catch {
    /* already released or not active */
  }
}

function completeInstruction(env, ticket, summary) {
  return {
    type: 'work_instruction',
    action: 'complete',
    state: {
      ticket,
      currentStep: 'complete',
      progress: `${env.ALL_STEPS.length}/${env.ALL_STEPS.length}`,
      completedSteps: env.ALL_STEPS,
      remainingSteps: [],
    },
    summary,
  };
}

/**
 * GH-398 (ECHO-4552 Issue 2): dispatcher-level early-return when the
 * workflow is in the terminal completed state. Per brief P0 #1, fires on
 * `state.status === 'completed'` ALONE — older state files (and any state
 * where the overall status flag was set without back-filling
 * `stepStatus.complete`) must short-circuit. The "all steps completed
 * including the canonical complete step" case is independently handled by
 * existing `getCurrentStep() === 'complete'` checks elsewhere in the
 * codebase, so the looser condition here does not narrow coverage.
 */
function terminalShortCircuit(env, ctx) {
  if (!ctx.preCheckState || ctx.preCheckState.status !== 'completed') return null;
  releaseSessionGuard(env, ctx.safeName);
  return completeInstruction(
    env,
    ctx.ticket,
    `Workflow ${ctx.safeName} already complete. Session released.`
  );
}

function readCiPhase(env, safeName) {
  const ciPhasePath = path.join(env.TASKS_BASE, safeName, 'ci-phase.json');
  try {
    return JSON.parse(fs.readFileSync(ciPhasePath, 'utf8'));
  } catch {
    // missing/unreadable → short-circuit MUST NOT fire
    return null;
  }
}

/**
 * Probe `gh pr view` from the canonical worktree. Skips the probe entirely
 * when the worktree dir is missing. Falling back to process.cwd() would run
 * `gh pr view` against whatever branch happens to be checked out there,
 * potentially querying an unrelated ticket's PR and destructively marking
 * THIS ticket's state as completed.
 */
function probePrState(env, safeBase) {
  const worktreeDir = path.join(env.WORKTREES_BASE, `${env.MAIN_WORKTREE_FOLDER}-${safeBase}`);
  if (!fs.existsSync(worktreeDir)) {
    throw new Error('worktree directory missing — skipping PR-merged probe');
  }
  const ghOut = execFileSync('gh', ['pr', 'view', '--json', 'state'], {
    cwd: worktreeDir,
    encoding: 'utf8',
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(ghOut);
}

function markStateCompleted(env, safeName) {
  const merged = env.loadWorkState(safeName);
  if (!merged) return;
  merged.status = 'completed';
  merged.completedTime = new Date().toISOString();
  env.ALL_STEPS.forEach((s) => {
    if (!merged.stepStatus) merged.stepStatus = {};
    merged.stepStatus[s] = 'completed';
  });
  env.saveWorkState(safeName, merged);
}

/**
 * Fail-open trace — any gh failure (non-zero exit, network, auth, JSON parse)
 * falls through to existing behavior. Trace to stderr when WORK2_DEBUG.
 */
function traceProbeFailure(err) {
  if (process.env.WORK2_DEBUG) {
    process.stderr.write(
      `[work-next] gh pr view probe failed (fail-open): ${err?.message || String(err)}\n`
    );
  }
}

/**
 * Short-circuit to `complete` when BOTH ci-phase.json is at `done` AND
 * `gh pr view` reports MERGED. Fail-open on gh errors; fail-closed on the
 * phase guard (missing or non-done ci-phase.json skips the short-circuit).
 */
function prMergedShortCircuit(env, ctx) {
  if (!ctx.preCheckState || ctx.preCheckState.status === 'completed') return null;
  try {
    const ciPhase = readCiPhase(env, ctx.safeName);
    if (!ciPhase || ciPhase.currentPhase !== 'done') {
      throw new Error('ci-phase.json not at terminal phase — skipping PR-merged probe');
    }
    const parsed = probePrState(env, ctx.safeBase);
    if (!parsed || parsed.state !== 'MERGED') return null;
    markStateCompleted(env, ctx.safeName);
    releaseSessionGuard(env, ctx.safeName);
    return completeInstruction(
      env,
      ctx.ticket,
      `Workflow ${ctx.safeName} already complete (PR merged). Session released.`
    );
  } catch (err) {
    traceProbeFailure(err);
    return null;
  }
}

/** Debug logging (env-gated, stderr). */
function debugTrace(env, preCheckState, safeName, recursionDepth) {
  if (!process.env.WORK2_DEBUG) return;
  const step = preCheckState ? env.getCurrentStep(preCheckState) : 'null';
  process.stderr.write(
    `[work-next] safeName=${safeName} currentStep=${step} dispatched=${preCheckState?._work2Dispatched || 'none'} depth=${recursionDepth}\n`
  );
  process.stderr.write(
    `[work-next] stepStatus: ${JSON.stringify(Object.fromEntries(Object.entries(preCheckState?.stepStatus || {}).filter(([, v]) => v !== 'pending')))}\n`
  );
}

module.exports = {
  blockedInstruction,
  buildInitialDeferState,
  resolveTicket,
  syncSessionGuardFile,
  persistPlanMetadata,
  terminalShortCircuit,
  prMergedShortCircuit,
  debugTrace,
};
