#!/usr/bin/env node

/**
 * work-next.js — Script-driven orchestrator for /work2.
 *
 * Outputs a SINGLE instruction — the next thing the AI should do.
 * A PostToolUse hook (work-auto-advance.js) calls this after each step
 * delegation completes, creating an automatic advance loop.
 *
 * Architecture:
 *   work-next.js          — DI wiring + core orchestration loop
 *   lib/instruction-builder.js  — delegation type mapping
 *   lib/state-context.js        — progress derivation from work state
 *   lib/marker.js               — session marker file management
 *   lib/step-enrichments/       — registry of per-step prompt overrides
 *
 * Usage: node work-next.js <TICKET_ID> [--rework] [--init]
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// Fail-safe handlers
if (require.main === module) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
}

// ─── Load shared modules from /work ─────────────────────────────────────────
const workDir = path.join(__dirname, '..', 'work');

function tryRequire(modulePath, fallback) {
  try {
    return require(modulePath);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return fallback;
    throw err;
  }
}

const { appendAction } = tryRequire(path.join(workDir, 'work-actions'), { appendAction: () => {} });
const tp = tryRequire(path.join(__dirname, '..', 'lib', 'ticket-provider'), null);
if (!tp) process.exit(0);

// ─── Configuration ──────────────────────────────────────────────────────────
const getConfig = require(path.join(__dirname, '..', 'lib', 'get-config'));
const WORKTREES_BASE = getConfig('WORKTREES_BASE') || '';
const TASKS_BASE =
  getConfig('TASKS_BASE') || (WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '');
const MAIN_WORKTREE_FOLDER = process.env.REPO_NAME || 'my-project';

if (!WORKTREES_BASE || !TASKS_BASE) {
  console.log(
    JSON.stringify({
      type: 'work_instruction',
      action: 'blocked',
      state: {
        ticket: null,
        currentStep: null,
        progress: '0/0',
        completedSteps: [],
        remainingSteps: [],
      },
      reason: 'WORKTREES_BASE or TASKS_BASE not configured',
      suggestion: 'Set WORKTREES_BASE and TASKS_BASE in your .envrc or environment',
    })
  );
  process.exit(0);
}

// ─── Shared modules from /work ──────────────────────────────────────────────
const { STEPS, STEP_TRANSITIONS, ALL_STEPS, workflowCanTransition } = require(
  path.join(workDir, 'step-registry')
);
const { run, fileExists, readFile, listFiles, ...helpers } = require(
  path.join(workDir, 'work-helpers')
);
const { parseTicketInput } = require(path.join(__dirname, '..', 'lib', 'ticket-provider'));
const { parseTasks, buildTaskPrompt } = require(path.join(workDir, 'task-parser'));
const { archiveStepArtifacts } = require(path.join(workDir, 'artifact-archival'));
const { getHeadSha } = require(path.join(workDir, 'git-utils'));
const { TDD_PROTOCOL, readTddEvidence: _readTddEvidence, validateTddEvidence } = require(
  path.join(workDir, 'tdd-enforcement')
);
const { inspect: _inspect } = require(path.join(workDir, 'inspect'));
const { generatePlan: _generatePlan } = require(path.join(workDir, 'plan-generator'));
const { transitionStep: _transitionStep } = require(path.join(workDir, 'transition-step'));
const { validateCheckGate: _validateCheckGate } = require(path.join(workDir, 'check-gate'));

// ─── Local modules ──────────────────────────────────────────────────────────
const { buildInstruction } = require(path.join(__dirname, 'lib', 'instruction-builder'));
const { buildStateContext } = require(path.join(__dirname, 'lib', 'state-context'));
const { writeMarkerFile } = require(path.join(__dirname, 'lib', 'marker'));
const { enrich } = require(path.join(__dirname, 'lib', 'step-enrichments'));

// ─── Constants ──────────────────────────────────────────────────────────────
const TDD_GATED_STEPS = [STEPS.implement];
const REQUIRED_REPORTS = [
  { file: 'tests.check.md', passPattern: /Status:\s*APPROVED/i },
  { file: 'code-review.check.md', passPattern: /Status:\s*APPROVED/i },
  { file: 'completion.check.md', passPattern: /Status:\s*(COMPLETE|APPROVED)/i },
];

// ─── DI wrappers (same pattern as work.workflow.js) ─────────────────────────
function loadWorkState(ticket) {
  return helpers.loadWorkState(TASKS_BASE, ticket);
}
function saveWorkState(ticket, state) {
  return helpers.saveWorkState(TASKS_BASE, ticket, state);
}
function getCurrentStep(workState) {
  return helpers.getCurrentStep(workState, STEPS, ALL_STEPS);
}
function readTddEvidence(ticketId, stepId, taskNum) {
  return _readTddEvidence(TASKS_BASE, ticketId, stepId, taskNum);
}
function validateCheckGate(ticket) {
  return _validateCheckGate(TASKS_BASE, ticket);
}

function inspect(ticket, providerConfig, suffix) {
  return _inspect(ticket, providerConfig, suffix, {
    tp,
    run,
    fileExists,
    readFile,
    listFiles,
    loadWorkState,
    getCurrentStep,
    REQUIRED_REPORTS,
    WORKTREES_BASE,
    TASKS_BASE,
    MAIN_WORKTREE_FOLDER,
  });
}

function generatePlan(ticket, description, s, rework, callerProviderCfg, suffix) {
  return _generatePlan(ticket, description, s, rework, callerProviderCfg, suffix, {
    tp,
    TDD_PROTOCOL,
    TDD_GATED_STEPS,
    STEPS,
    parseTasks,
    buildTaskPrompt,
    fileExists,
    run,
    WORKTREES_BASE,
    TASKS_BASE,
    MAIN_WORKTREE_FOLDER,
  });
}

let _workflowDef = null;
function getWorkflowDefinition() {
  if (!_workflowDef) {
    const createWorkflowDefinition = require(path.join(workDir, 'workflow-definition'));
    const providerConfig = tp.getProviderConfig({ skipPrompt: true });
    _workflowDef = createWorkflowDefinition({
      TASKS_BASE,
      safeTicketPath: (id) => tp.sanitizeTicketIdForPath(id, providerConfig),
      resolveGitHead: () => {
        const { resolveGitHead } = require(path.join(workDir, 'git-utils'));
        return resolveGitHead();
      },
    });
  }
  return _workflowDef;
}

function buildTransitionDeps() {
  const { workflow } = getWorkflowDefinition();
  return {
    tp,
    STEPS,
    ALL_STEPS,
    STEP_TRANSITIONS,
    workflowCanTransition,
    TDD_GATED_STEPS,
    readTddEvidence,
    validateTddEvidence,
    validateCheckGate,
    archiveStepArtifacts,
    appendAction,
    loadWorkState,
    saveWorkState,
    getCurrentStep,
    TASKS_BASE,
    softSteps: workflow.softSteps,
    commandMap: workflow.commandMap,
    getHeadSha,
  };
}

function transitionStep(ticket, targetStep) {
  return _transitionStep(ticket, targetStep, buildTransitionDeps());
}

// ─── Core Orchestration Loop ────────────────────────────────────────────────

let _recursionDepth = 0;
const MAX_RECURSION = 10;

function getNextInstruction(ticketRaw, rework) {
  if (_recursionDepth >= MAX_RECURSION) {
    return {
      type: 'work_instruction',
      action: 'blocked',
      state: {
        ticket: ticketRaw,
        currentStep: null,
        progress: '0/0',
        completedSteps: [],
        remainingSteps: [],
      },
      reason: 'Max recursion depth reached during auto-advance',
      suggestion: 'Run work-next.js again — the workflow may be stuck',
    };
  }
  _recursionDepth++;

  // Parse ticket input
  let ticketBase, suffix;
  try {
    const parsed = parseTicketInput(ticketRaw);
    ticketBase = parsed.ticketBase;
    suffix = parsed.suffix;
  } catch (err) {
    return {
      type: 'work_instruction',
      action: 'blocked',
      state: {
        ticket: ticketRaw,
        currentStep: null,
        progress: '0/0',
        completedSteps: [],
        remainingSteps: [],
      },
      reason: err.message,
      suggestion: 'Check ticket ID format',
    };
  }

  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  const isGitHub = providerConfig?.provider === 'github';

  // Normalize ticket
  let ticket = ticketBase.toUpperCase();
  if ((/^#?\d+$/.test(ticketBase) || /^GH-\d+$/i.test(ticketBase)) && isGitHub) {
    const num = ticketBase.replace(/^#|^GH-/i, '');
    ticket = '#' + num;
  }

  const isTicket = /^[A-Z]+-\d+$/i.test(ticket) || (/^#\d+$/.test(ticket) && isGitHub);

  // Inspect current state
  const state = isTicket ? inspect(ticket, providerConfig, suffix) : null;

  // Generate plan
  let result;
  try {
    result = generatePlan(
      ticket,
      isTicket ? null : ticketRaw,
      state,
      rework,
      providerConfig,
      suffix
    );
  } catch (err) {
    return {
      type: 'work_instruction',
      action: 'blocked',
      state: { ticket, currentStep: null, progress: '0/0', completedSteps: [], remainingSteps: [] },
      reason: err?.message || String(err),
      suggestion: 'Check ticket exists and is accessible',
    };
  }

  // Override session guard workflow field
  const safeBase = tp.sanitizeTicketIdForPath(ticket, providerConfig);
  const safeName = suffix ? safeBase + '/' + suffix : safeBase;
  if (process.env.SESSION_GUARD_ENABLED !== '0') {
    try {
      const sessionDir = process.env.SESSION_GUARD_DIR || '/tmp';
      const sanitizedId = String(safeBase).replace(/[/\\:\0]/g, '_');
      const sessionPath = path.join(sessionDir, `claude-session-guard-${sanitizedId}.json`);
      if (fs.existsSync(sessionPath)) {
        const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        session.workflow = '/work2';
        // Fix cwd to point to the worktree (not the calling cwd)
        const worktreeDir = path.join(WORKTREES_BASE, `${MAIN_WORKTREE_FOLDER}-${safeBase}`);
        session.cwd = worktreeDir;
        fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
      }
    } catch {
      /* fail-open */
    }
  }

  // Persist DEFER metadata
  result.timestamp = new Date().toISOString();
  const planState = loadWorkState(safeName);
  if (planState) {
    planState.lastPlanTimestamp = result.timestamp;
    planState.deferredSteps = result.plan.filter((s) => s.action === 'DEFER').map((s) => s.step);
    saveWorkState(safeName, planState);
  } else {
    const deferSteps = result.plan.filter((s) => s.action === 'DEFER').map((s) => s.step);
    if (deferSteps.length > 0) {
      const minimalState = {
        ticketId: safeName,
        description: '',
        currentStep: 1,
        status: 'in_progress',
        stepStatus: {},
        checkProgress: {},
        errors: [],
        startTime: new Date().toISOString(),
        lastPlanTimestamp: result.timestamp,
        deferredSteps: deferSteps,
      };
      ALL_STEPS.forEach((s) => {
        minimalState.stepStatus[s] = 'pending';
      });
      saveWorkState(safeName, minimalState);
      appendAction(safeName, { step: STEPS.ticket, what: 'workflow started (work2)' });
    }
  }

  const plan = result.plan;
  const tasksDir = path.join(TASKS_BASE, safeName);

  // Debug logging (env-gated)
  const _dbgState = loadWorkState(safeName);
  if (process.env.WORK2_DEBUG) {
    process.stderr.write(
      `[work-next] safeName=${safeName} currentStep=${_dbgState ? getCurrentStep(_dbgState) : 'null'} dispatched=${_dbgState?._work2Dispatched || 'none'} depth=${_recursionDepth}\n`
    );
    process.stderr.write(
      `[work-next] stepStatus: ${JSON.stringify(Object.fromEntries(Object.entries(_dbgState?.stepStatus || {}).filter(([, v]) => v !== 'pending')))}\n`
    );
  }

  const stateCtx = buildStateContext(ticket, plan, safeName, {
    loadWorkState,
    getCurrentStep,
    ALL_STEPS,
  });

  // Handle task-advance if needed
  if (result.nextAction === 'advance_task') {
    try {
      const workStatePath = path.join(workDir, 'work-state.js');
      execFileSync(process.execPath, [workStatePath, 'task-advance', safeName], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: 'pipe',
      });
      return getNextInstruction(ticketRaw, rework);
    } catch {
      /* fail-open */
    }
  }

  // ─── Step iteration loop ────────────────────────────────────────────────
  const workState = loadWorkState(safeName);
  const currentStepName = workState ? getCurrentStep(workState) : null;
  const currentStepIdx = currentStepName ? ALL_STEPS.indexOf(currentStepName) : -1;

  // Enrichment context for step overrides
  const enrichCtx = { tasksDir, ticket, workDir, path, fs, tp, TASKS_BASE };

  for (const entry of plan) {
    if (entry.action === 'SKIP') continue;

    if (entry.action === 'RUN' || entry.action === 'DEFER') {
      const entryIdx = ALL_STEPS.indexOf(entry.step);

      // Pseudo-steps (e.g., 2b_transition) not in ALL_STEPS — execute directly
      if (entryIdx < 0) {
        const dispatched = workState?._work2PseudoDispatched || [];
        if (dispatched.includes(entry.step)) continue;
        const ws = loadWorkState(safeName);
        if (ws) {
          ws._work2PseudoDispatched = [...(ws._work2PseudoDispatched || []), entry.step];
          saveWorkState(safeName, ws);
        }
        if (entry.agentType && entry.agentPrompt) {
          enrich(entry, enrichCtx);
          return buildInstruction(entry, stateCtx);
        }
        continue;
      }

      // Skip steps behind current position
      if (currentStepIdx >= 0 && entryIdx < currentStepIdx) continue;

      // Current step — handle dispatched marker logic
      if (entry.step === currentStepName) {
        if (workState && workState._work2Dispatched === entry.step) {
          // Already dispatched — try to transition forward.
          // The transition gate (verify function) determines if the step is truly done.
          // Soft steps pass immediately; gated steps (brief_gate, spec_gate) only pass
          // when their verify() returns true (e.g., questions resolved, gherkin valid).
          // Only try FORWARD transitions (higher index in ALL_STEPS)
          // Backward transitions would revert state and cause loops
          const allowed = (STEP_TRANSITIONS[entry.step] || []).filter(
            (t) => ALL_STEPS.indexOf(t) > ALL_STEPS.indexOf(entry.step)
          );
          for (const target of allowed) {
            const transResult = transitionStep(safeName, target);
            if (process.env.WORK2_DEBUG) {
              process.stderr.write(
                `[work-next] dispatch-advance ${entry.step}→${target}: ${transResult?.error ? transResult.message : 'SUCCESS'}\n`
              );
            }
            if (transResult && !transResult.error) {
              const ws = loadWorkState(safeName);
              if (ws) {
                delete ws._work2Dispatched;
                delete ws._work2DispatchedAction;
                saveWorkState(safeName, ws);
              }
              return getNextInstruction(ticketRaw, rework);
            }
          }
          // Transition blocked — log the last failure (debug only, no re-attempt)
          if (process.env.WORK2_DEBUG) {
            process.stderr.write(
              `[work-next] dispatch-advance BLOCKED for ${entry.step}, tried ${allowed.length} forward targets\n`
            );
          }
          // Step genuinely needs more work, return instruction again
        }

        // Mark as dispatched (with action) and set stepStatus to in_progress
        const ws = loadWorkState(safeName);
        if (ws) {
          ws._work2Dispatched = entry.step;
          ws._work2DispatchedAction = entry.action;
          // Ensure step is marked in_progress so the plan generator
          // can detect it was started (and mark it DEFER/SKIP on completion)
          if (ws.stepStatus && ws.stepStatus[entry.step] === 'pending') {
            ws.stepStatus[entry.step] = 'in_progress';
          }
          saveWorkState(safeName, ws);
        }

        if (entry.agentType && entry.agentPrompt) {
          enrich(entry, enrichCtx);
          return buildInstruction(entry, { ...stateCtx, currentStep: entry.step });
        }
        continue;
      }

      // Forward transition to this step
      const transResult = transitionStep(safeName, entry.step);
      if (transResult && transResult.error) {
        return {
          type: 'work_instruction',
          action: 'blocked',
          state: { ...stateCtx, currentStep: entry.step },
          reason: transResult.message || 'Transition blocked',
          suggestion: transResult.suggestion || `Resolve the gate for step: ${entry.step}`,
        };
      }

      // Transition succeeded
      if (entry.agentType && entry.agentPrompt) {
        enrich(entry, enrichCtx);
        return buildInstruction(entry, { ...stateCtx, currentStep: entry.step });
      }
      continue;
    }
  }

  // All steps done
  return {
    type: 'work_instruction',
    action: 'complete',
    state: stateCtx,
    summary: `All ${plan.length} steps done for ${ticket}`,
  };
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log(
      JSON.stringify({
        type: 'work_instruction',
        action: 'blocked',
        state: {
          ticket: null,
          currentStep: null,
          progress: '0/0',
          completedSteps: [],
          remainingSteps: [],
        },
        reason: 'No ticket ID provided',
        suggestion: 'Usage: node work-next.js <TICKET_ID> [--rework]',
      })
    );
    process.exit(0);
  }

  const rework = args.includes('--rework');
  const init = args.includes('--init');
  const ticketRaw = args
    .filter((a) => !a.startsWith('--'))
    .join(' ')
    .trim();

  // On --init, write marker file for auto-advance hook detection
  if (init) {
    const sessionId =
      process.env.SESSION_ID || process.env.CLAUDE_SESSION_ID || `work2-${Date.now()}`;
    writeMarkerFile(ticketRaw, sessionId, { TASKS_BASE, tp });
  }

  const instruction = getNextInstruction(ticketRaw, rework);
  console.log(JSON.stringify(instruction, null, 2));
}

if (require.main === module) main();

module.exports = { getNextInstruction, buildStateContext, buildInstruction };
