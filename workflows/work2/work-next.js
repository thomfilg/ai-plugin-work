#!/usr/bin/env node

/**
 * work-next.js — Script-driven orchestrator for /work2.
 *
 * Instead of outputting a full plan JSON for the AI to parse and manage,
 * this script outputs a SINGLE instruction — the next thing the AI should do.
 *
 * A PostToolUse hook (work-auto-advance.js) calls this after each step
 * delegation completes, creating an automatic advance loop.
 *
 * Usage:
 *   node work-next.js <TICKET_ID> [--rework] [--init]
 *
 * Output: JSON instruction to stdout (see instruction format in plan).
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

// ─── Core Logic ─────────────────────────────────────────────────────────────

function buildStateContext(ticket, plan, safeName) {
  // Derive state from work-state.json stepStatus (source of truth), not from plan actions
  const ws = loadWorkState(safeName);
  const stepStatus = ws?.stepStatus || {};
  const currentStepName = ws ? getCurrentStep(ws) : null;

  const completed = ALL_STEPS.filter((s) => stepStatus[s] === 'completed');
  const currentIdx = currentStepName ? ALL_STEPS.indexOf(currentStepName) : 0;
  const remaining = ALL_STEPS.filter(
    (s) => ALL_STEPS.indexOf(s) > currentIdx && stepStatus[s] !== 'completed'
  );

  return {
    ticket,
    currentStep: currentStepName || plan[0]?.step || 'ticket',
    progress: `${completed.length + 1}/${ALL_STEPS.length}`,
    completedSteps: completed,
    remainingSteps: remaining,
  };
}

function buildInstruction(entry, stateCtx) {
  const instruction = {
    type: 'work_instruction',
    action: 'execute',
    state: stateCtx,
    continue: true,
  };

  // preCommands
  if (entry.preCommands && entry.preCommands.length > 0) {
    instruction.preCommands = entry.preCommands;
  }

  // Context enrichment: inject ticket details file reference into prompts that need it
  const ticket = stateCtx.ticket;
  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  const safeBase = tp.sanitizeTicketIdForPath(ticket, providerConfig);
  const tasksDir = path.join(TASKS_BASE, safeBase);
  const ticketFile = path.join(tasksDir, 'ticket.json');

  // For ticket step: add instruction to save output to file
  if (entry.step === 'ticket') {
    const saveCmd = `gh issue view ${ticket.replace('#', '')} --json title,body,state,labels > "${ticketFile}"`;
    entry.agentPrompt = `${entry.agentPrompt}\n\nIMPORTANT: Also save the raw JSON output to: ${ticketFile}\nRun: ${saveCmd}`;
  }

  // For steps that benefit from ticket context: append file reference
  if (['brief', 'spec', 'implement'].includes(entry.step)) {
    if (fs.existsSync(ticketFile)) {
      try {
        const ticketData = JSON.parse(fs.readFileSync(ticketFile, 'utf8'));
        const contextBlock = `\n\n## Ticket Context\nTitle: ${ticketData.title}\nState: ${ticketData.state}\n\n${ticketData.body || '(no body)'}`;
        entry.agentPrompt = (entry.agentPrompt || '') + contextBlock;
      } catch {
        /* fail-open */
      }
    }
  }

  // Delegation block
  if (entry.agentType === 'skill') {
    // Extract skill name from agentPrompt (e.g., "/check" → "check", "/work-implement ..." → "work-implement")
    const skillMatch = (entry.agentPrompt || '').match(/^\/([\w-]+)/);
    instruction.delegate = {
      type: 'skill',
      name: skillMatch ? skillMatch[1] : entry.command,
      prompt: entry.agentPrompt,
    };
  } else if (entry.agentType === 'Bash' || entry.agentType === 'bash') {
    instruction.delegate = {
      type: 'bash',
      description: `${entry.step} ${entry.reason || ''}`.trim(),
      command: entry.agentPrompt || entry.command,
    };
  } else {
    // Task-based (general-purpose, brief-writer, spec-writer, commit-writer, etc.)
    // Detect simple single-command prompts and emit as "bash" instead of spawning an agent
    const prompt = entry.agentPrompt || '';
    const isSingleCommand =
      entry.agentType === 'general-purpose' &&
      /^(Fetch|Run|Execute|Check)\b/.test(prompt) &&
      /\bgh\s|\bgit\s|\bnode\s|\bcurl\s/.test(prompt) &&
      prompt.split('\n').filter((l) => l.trim()).length <= 3;

    if (isSingleCommand) {
      instruction.delegate = {
        type: 'bash',
        description: `${entry.step} ${entry.reason || ''}`.trim().slice(0, 80),
        command: prompt,
      };
    } else {
      instruction.delegate = {
        type: 'task',
        agentType: entry.agentType,
        description: `${entry.step} ${entry.reason || ''}`.trim().slice(0, 80),
        prompt,
      };
    }
  }

  return instruction;
}

let _recursionDepth = 0;
const MAX_RECURSION = 10; // prevent infinite loops through soft steps

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

  // Override session guard: generatePlan() inits with '/work', we patch the session
  // file to '/work2' so session-guard Stop hook shows the correct work-next.js command.
  // cmdInit is idempotent and won't overwrite the workflow field, so we patch directly.
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
        fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
      }
    } catch {
      /* fail-open */
    }
  }

  // Persist DEFER metadata (same as cli.js plan command)
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

  // Debug: log state for troubleshooting (stderr only, not visible to AI)
  const _dbgState = loadWorkState(safeName);
  if (process.env.WORK2_DEBUG) {
    process.stderr.write(
      `[work-next] safeName=${safeName} currentStep=${_dbgState ? getCurrentStep(_dbgState) : 'null'} dispatched=${_dbgState?._work2Dispatched || 'none'} depth=${_recursionDepth}\n`
    );
    process.stderr.write(
      `[work-next] stepStatus: ${JSON.stringify(Object.fromEntries(Object.entries(_dbgState?.stepStatus || {}).filter(([, v]) => v !== 'pending')))}\n`
    );
  }

  const stateCtx = buildStateContext(ticket, plan, safeName);

  // Handle task-advance if needed
  if (result.nextAction === 'advance_task') {
    try {
      const workStatePath = path.join(workDir, 'work-state.js');
      execFileSync(process.execPath, [workStatePath, 'task-advance', safeName], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: 'pipe',
      });
      // Re-run after advancing (depth-limited by _recursionDepth)
      return getNextInstruction(ticketRaw, rework);
    } catch {
      /* fail-open */
    }
  }

  // Find first actionable step
  // Determine current step from work state to skip steps we've already passed
  const workState = loadWorkState(safeName);
  const currentStepName = workState ? getCurrentStep(workState) : null;
  const currentStepIdx = currentStepName ? ALL_STEPS.indexOf(currentStepName) : -1;

  for (const entry of plan) {
    if (entry.action === 'SKIP') continue;

    if (entry.action === 'RUN' || entry.action === 'DEFER') {
      const entryIdx = ALL_STEPS.indexOf(entry.step);

      // Pseudo-steps (e.g., 2b_transition) are not in ALL_STEPS — execute directly without transitions
      if (entryIdx < 0) {
        // Check if already dispatched (pseudo-steps have no state machine tracking)
        const dispatched = workState?._work2PseudoDispatched || [];
        if (dispatched.includes(entry.step)) {
          continue; // Already executed, skip
        }
        // Mark as dispatched
        const ws = loadWorkState(safeName);
        if (ws) {
          ws._work2PseudoDispatched = [...(ws._work2PseudoDispatched || []), entry.step];
          saveWorkState(safeName, ws);
        }
        if (entry.agentType && entry.agentPrompt) {
          return buildInstruction(entry, stateCtx);
        }
        continue;
      }

      // Skip steps that are behind the current step in the state machine
      // The plan may mark them as RUN but the state already advanced past them
      if (currentStepIdx >= 0 && entryIdx < currentStepIdx) {
        continue;
      }

      // If this is the current step...
      if (entry.step === currentStepName) {
        // Check if we already dispatched this step in a previous call
        if (workState && workState._work2Dispatched === entry.step) {
          // Step was already executed — try to transition forward
          const allowed = STEP_TRANSITIONS[entry.step] || [];
          let advanced = false;
          for (const target of allowed) {
            const transResult = transitionStep(safeName, target);
            if (transResult && !transResult.error) {
              // Successfully advanced! Clear dispatched flag and recurse
              const ws = loadWorkState(safeName);
              if (ws) {
                delete ws._work2Dispatched;
                saveWorkState(safeName, ws);
              }
              return getNextInstruction(ticketRaw, rework);
            }
          }
          // All transitions blocked — step needs more work, return instruction again
        }

        // Mark step as dispatched for next call
        const ws = loadWorkState(safeName);
        if (ws) {
          ws._work2Dispatched = entry.step;
          saveWorkState(safeName, ws);
        }

        if (entry.agentType && entry.agentPrompt) {
          return buildInstruction(entry, { ...stateCtx, currentStep: entry.step });
        }
        continue;
      }

      // Need to transition forward to this step
      const transResult = transitionStep(safeName, entry.step);

      if (transResult && transResult.error) {
        // Gate blocked
        return {
          type: 'work_instruction',
          action: 'blocked',
          state: { ...stateCtx, currentStep: entry.step },
          reason: transResult.message || 'Transition blocked',
          suggestion: transResult.suggestion || `Resolve the gate for step: ${entry.step}`,
        };
      }

      // Transition succeeded — check if it needs AI execution
      if (entry.agentType && entry.agentPrompt) {
        return buildInstruction(entry, { ...stateCtx, currentStep: entry.step });
      }

      // No agentType means this is a pass-through (rare) — continue to next
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

// ─── Marker file management ─────────────────────────────────────────────────

function writeMarkerFile(ticket, sessionId) {
  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  const safeBase = tp.sanitizeTicketIdForPath(ticket.toUpperCase(), providerConfig);
  const tasksDir = path.join(TASKS_BASE, safeBase);
  try {
    fs.mkdirSync(tasksDir, { recursive: true });
    const markerPath = path.join(tasksDir, '.work2-orchestrator.pid');
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ sessionId, ticket, startedAt: new Date().toISOString() })
    );
  } catch {
    /* fail-open */
  }
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
    writeMarkerFile(ticketRaw, sessionId);
  }

  const instruction = getNextInstruction(ticketRaw, rework);
  console.log(JSON.stringify(instruction, null, 2));
}

if (require.main === module) main();

module.exports = { getNextInstruction, buildStateContext, buildInstruction };
