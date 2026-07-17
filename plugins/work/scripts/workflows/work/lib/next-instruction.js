'use strict';

/**
 * next-instruction.js — core orchestration loop for work-next.
 *
 * IMPORTANT: This module is the generic orchestrator. NO step-specific logic
 * here. Step-specific behavior (prompts, gates, delegation overrides) belongs
 * in lib/step-enrichments/ — registered via enrich() and runGate().
 *
 * `createGetNextInstruction(env)` wires the orchestrator environment (built
 * by work-next.js) into a `getNextInstruction(ticketRaw, rework)` closure
 * that owns the recursion-depth guard.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const { buildInstruction } = require('./instruction-builder');
const { buildStateContext } = require('./state-context');
const { enrich, runGate } = require('./step-enrichments');
const { createDebugLog } = require('./debug-log');
const { checkVersionSkew } = require('./version-skew');
const preflight = require('./next-preflight');

const MAX_RECURSION = 10;

/** Log and return instruction (enrichments can override it entirely). */
function returnInstruction(entry, ctx, log) {
  // Enrichments can override the entire instruction (e.g., brief_gate blocking for user input)
  if (entry._overrideInstruction) {
    log.instruction(entry._overrideInstruction);
    return entry._overrideInstruction;
  }
  const instr = buildInstruction(entry, ctx);
  log.instruction(instr);
  return instr;
}

/**
 * Enrichment context for step overrides. `workDir` is the PLUGIN's own
 * workflows/work directory (for lib requires) — NOT the ticket worktree.
 * `worktreeDir` is the canonical ticket worktree; enrichments that shell
 * out to git (e.g. the check step's Gate E scope-diff) MUST use it, or
 * they end up diffing the plugin checkout (ECHO-5818/5821: 240 phantom
 * "unaccounted" plugin files injected into the check prompt).
 */
function buildEnrichCtx(env, loop) {
  const enrichWorktreeDir =
    env.WORKTREES_BASE && env.MAIN_WORKTREE_FOLDER
      ? path.join(env.WORKTREES_BASE, `${env.MAIN_WORKTREE_FOLDER}-${loop.safeBase}`)
      : undefined;
  return {
    tasksDir: loop.tasksDir,
    ticket: loop.ticket,
    workDir: env.workDir,
    worktreeDir: enrichWorktreeDir,
    path,
    fs,
    tp: env.tp,
    TASKS_BASE: env.TASKS_BASE,
  };
}

/**
 * When the entry carries an agent delegation, enrich it and wrap the built
 * instruction as a loop outcome. Returns undefined for non-delegating entries
 * (the loop moves on to the next plan entry).
 */
function enrichAndReturn(loop, entry, ctx) {
  if (entry.agentType && entry.agentPrompt) {
    enrich(entry, loop.enrichCtx);
    return { instruction: returnInstruction(entry, ctx, loop.log) };
  }
  return undefined;
}

/** Pseudo-steps (e.g., 2b_transition) not in ALL_STEPS — execute directly. */
function handlePseudoStep(env, loop, entry) {
  const dispatched = loop.workState?._work2PseudoDispatched || [];
  if (dispatched.includes(entry.step)) return undefined;
  const ws = env.loadWorkState(loop.safeName);
  if (ws) {
    ws._work2PseudoDispatched = [...(ws._work2PseudoDispatched || []), entry.step];
    env.saveWorkState(loop.safeName, ws);
  }
  return enrichAndReturn(loop, entry, loop.stateCtx);
}

/** Gate didn't handle it — try standard transitions. */
function tryStandardTransitions(env, loop, entry) {
  const allowed = (env.STEP_TRANSITIONS[entry.step] || []).filter(
    (t) => env.ALL_STEPS.indexOf(t) > env.ALL_STEPS.indexOf(entry.step)
  );
  for (const target of allowed) {
    const transResult = env.transitionStep(loop.safeName, target);
    loop.log.transition(entry.step, target, transResult?.error ? transResult.message : 'SUCCESS');
    if (!transResult || transResult.error) continue;
    const ws = env.loadWorkState(loop.safeName);
    if (ws) {
      delete ws._work2Dispatched;
      delete ws._work2DispatchedAction;
      env.saveWorkState(loop.safeName, ws);
    }
    loop.log.recurse(loop.recursionDepth, `advanced ${entry.step} → ${target}`);
    return { instruction: loop.recurse() };
  }
  loop.log.error(`dispatch-advance BLOCKED for ${entry.step}`, { tried: allowed.length });
  // Step genuinely needs more work — caller returns the instruction again.
  return undefined;
}

/**
 * Pre-transition gate: runs BEFORE transitionStep to avoid hanging on verify
 * functions (e.g., isPRGateReady calls checkCI which blocks). Gates like
 * follow-up-gate and check-gate read sub-orchestrator state and advance
 * directly when their sub-workflow completed.
 *
 * The worktreeDir is the canonical worktree for this ticket so the gate's
 * test commands run inside the ticket's worktree — NOT whichever shell cwd
 * the PostToolUse hook happened to fire from. Cross-shell invocations (one
 * shell per worktree) used to leak: the gate would run tests from worktree A
 * but write evidence into ticket B.
 */
function runDispatchedGate(env, loop, entry) {
  const worktreeDir = path.join(env.WORKTREES_BASE, `${env.MAIN_WORKTREE_FOLDER}-${loop.safeBase}`);
  const preGateResult = runGate(
    entry.step,
    loop.safeName,
    { ticket: loop.ticket, stateCtx: loop.stateCtx, tasksDir: loop.tasksDir, worktreeDir },
    {
      loadWorkState: env.loadWorkState,
      saveWorkState: env.saveWorkState,
      readTddEvidence: env.readTddEvidence,
      validateTddEvidence: env.validateTddEvidence,
      stepName: entry.step,
      workDir: env.workDir,
      work2Dir: env.work2Dir,
      log: loop.log,
      recursionDepth: loop.recursionDepth,
    }
  );
  if (preGateResult) {
    if (preGateResult.recurse) return { instruction: loop.recurse() };
    return { instruction: preGateResult };
  }
  return tryStandardTransitions(env, loop, entry);
}

/** Mark as dispatched (with action) and set stepStatus to in_progress. */
function markStepDispatched(env, loop, entry) {
  const ws = env.loadWorkState(loop.safeName);
  if (!ws) return;
  ws._work2Dispatched = entry.step;
  ws._work2DispatchedAction = entry.action;
  // Ensure step is marked in_progress so the plan generator
  // can detect it was started (and mark it DEFER/SKIP on completion)
  if (ws.stepStatus && ws.stepStatus[entry.step] === 'pending') {
    ws.stepStatus[entry.step] = 'in_progress';
  }
  env.saveWorkState(loop.safeName, ws);
}

/** Current step — handle dispatched marker logic. */
function handleCurrentStep(env, loop, entry) {
  if (loop.workState && loop.workState._work2Dispatched === entry.step) {
    const gateOutcome = runDispatchedGate(env, loop, entry);
    if (gateOutcome) return gateOutcome;
  }
  markStepDispatched(env, loop, entry);
  return enrichAndReturn(loop, entry, { ...loop.stateCtx, currentStep: entry.step });
}

/** Forward transition to this step. */
function handleForwardStep(env, loop, entry) {
  const transResult = env.transitionStep(loop.safeName, entry.step);
  if (transResult && transResult.error) {
    return {
      instruction: {
        type: 'work_instruction',
        action: 'blocked',
        state: { ...loop.stateCtx, currentStep: entry.step },
        reason: transResult.message || 'Transition blocked',
        suggestion: transResult.suggestion || `Resolve the gate for step: ${entry.step}`,
      },
    };
  }
  // Transition succeeded
  return enrichAndReturn(loop, entry, { ...loop.stateCtx, currentStep: entry.step });
}

function handlePlanEntry(env, loop, entry) {
  const entryIdx = env.ALL_STEPS.indexOf(entry.step);
  loop.log.step(entry.step, entry.action, entryIdx < 0 ? { pseudo: true } : null);
  if (entryIdx < 0) return handlePseudoStep(env, loop, entry);
  // Skip steps behind current position
  if (loop.currentStepIdx >= 0 && entryIdx < loop.currentStepIdx) return undefined;
  if (entry.step === loop.currentStepName) return handleCurrentStep(env, loop, entry);
  return handleForwardStep(env, loop, entry);
}

/** Step iteration loop over the generated plan. */
function runPlanLoop(env, ctx) {
  const workState = env.loadWorkState(ctx.safeName);
  const currentStepName = workState ? env.getCurrentStep(workState) : null;
  const currentStepIdx = currentStepName ? env.ALL_STEPS.indexOf(currentStepName) : -1;
  ctx.log.state(currentStepName, workState?.stepStatus, workState?._work2Dispatched);
  const loop = { ...ctx, workState, currentStepName, currentStepIdx };
  loop.enrichCtx = buildEnrichCtx(env, loop);
  for (const entry of ctx.plan) {
    if (entry.action !== 'RUN' && entry.action !== 'DEFER') continue;
    const outcome = handlePlanEntry(env, loop, entry);
    if (outcome) return outcome.instruction;
  }
  // All steps done
  const completeInstr = {
    type: 'work_instruction',
    action: 'complete',
    state: ctx.stateCtx,
    summary: `All ${ctx.plan.length} steps done for ${ctx.ticket}`,
  };
  ctx.log.instruction(completeInstr);
  return completeInstr;
}

/** Handle task-advance if needed. Returns true when the caller must recurse. */
function handleAdvanceTask(env, safeName) {
  try {
    const workStatePath = path.join(env.workDir, 'work-state.js');
    execFileSync(process.execPath, [workStatePath, 'task-advance', safeName], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: 'pipe',
    });
    return true;
  } catch {
    /* fail-open */
    return false;
  }
}

/** Inspect current state, then generate the plan (blocked instruction on error). */
function generatePlanSafe(env, resolved, ticketRaw, rework) {
  const { ticket, suffix, isTicket, providerConfig } = resolved;
  const state = isTicket ? env.inspect(ticket, providerConfig, suffix) : null;
  try {
    return {
      result: env.generatePlan(
        ticket,
        isTicket ? null : ticketRaw,
        state,
        rework,
        providerConfig,
        suffix
      ),
    };
  } catch (err) {
    return {
      blocked: preflight.blockedInstruction(
        ticket,
        err?.message || String(err),
        'Check ticket exists and is accessible'
      ),
    };
  }
}

/**
 * GH-768: plugin version skew check — once per top-level invocation
 * (auto-advance recursion re-enters with recursionDepth > 1). Warn-only:
 * a non-null banner is surfaced via stateCtx.versionSkew, never a block.
 */
function maybeAttachVersionSkew(env, { recursionDepth, preCheckState, safeName, stateCtx }) {
  if (recursionDepth !== 1) return;
  const versionSkew = checkVersionSkew({
    ws: preCheckState,
    safeName,
    statePath: path.join(env.TASKS_BASE, safeName, '.work-state.json'),
    // The persisted state has no `step` string field — resolve the current
    // step name from stepStatus via the shared accessor for the audit row.
    currentStep: env.getCurrentStep(preCheckState),
    appendAction: env.appendAction,
    saveWorkState: env.saveWorkState,
  });
  if (versionSkew) stateCtx.versionSkew = versionSkew;
}

function createGetNextInstruction(env) {
  let recursionDepth = 0;

  function getNextInstruction(ticketRaw, rework) {
    if (recursionDepth >= MAX_RECURSION) {
      return preflight.blockedInstruction(
        ticketRaw,
        'Max recursion depth reached during auto-advance',
        'Run work-next.js again — the workflow may be stuck'
      );
    }
    recursionDepth++;
    const resolved = preflight.resolveTicket(env, ticketRaw);
    if (resolved.blocked) return resolved.blocked;
    const { ticket, suffix, separator, providerConfig } = resolved;

    const planned = generatePlanSafe(env, resolved, ticketRaw, rework);
    if (planned.blocked) return planned.blocked;
    const result = planned.result;

    const safeBase = env.tp.sanitizeTicketIdForPath(ticket, providerConfig);
    const safeName = suffix ? safeBase + '/' + suffix : safeBase;
    preflight.syncSessionGuardFile(env, safeBase);
    preflight.persistPlanMetadata(env, { result, safeName, safeBase, suffix, separator });

    const plan = result.plan;
    const tasksDir = path.join(env.TASKS_BASE, safeName);
    const log = createDebugLog(tasksDir);
    log.call(ticket, process.argv.slice(2).join(' '));

    const preCheckState = env.loadWorkState(safeName);
    const shortCircuit =
      preflight.terminalShortCircuit(env, { preCheckState, ticket, safeName }) ||
      preflight.prMergedShortCircuit(env, { preCheckState, ticket, safeName, safeBase });
    if (shortCircuit) return shortCircuit;
    preflight.debugTrace(env, preCheckState, safeName, recursionDepth);

    const stateCtx = buildStateContext(ticket, plan, safeName, {
      loadWorkState: env.loadWorkState,
      getCurrentStep: env.getCurrentStep,
      ALL_STEPS: env.ALL_STEPS,
    });
    maybeAttachVersionSkew(env, { recursionDepth, preCheckState, safeName, stateCtx });
    const recurse = () => getNextInstruction(ticketRaw, rework);
    if (result.nextAction === 'advance_task' && handleAdvanceTask(env, safeName)) {
      return recurse();
    }
    return runPlanLoop(env, {
      plan,
      ticket,
      safeName,
      safeBase,
      stateCtx,
      tasksDir,
      log,
      recurse,
      recursionDepth,
    });
  }

  return getNextInstruction;
}

module.exports = { createGetNextInstruction };
