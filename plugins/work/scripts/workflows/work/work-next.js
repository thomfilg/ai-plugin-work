#!/usr/bin/env node

/**
 * work-next.js — Script-driven orchestrator for /work.
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

// Error handlers — log errors as blocked instructions instead of swallowing silently
if (require.main === module) {
  process.on('uncaughtException', (err) => {
    console.error(
      JSON.stringify({
        type: 'work_instruction',
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
        type: 'work_instruction',
        action: 'blocked',
        reason: `Unhandled rejection: ${msg}`,
      })
    );
    process.exit(1);
  });
}

// ─── Load shared modules from /work ─────────────────────────────────────────
const { resolvePluginPaths } = require(path.join(__dirname, 'lib', 'resolve-plugin-root'));
const { workDir, libDir } = resolvePluginPaths(__dirname);

function tryRequire(modulePath, fallback) {
  try {
    return require(modulePath);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') return fallback;
    throw err;
  }
}

const { appendAction } = tryRequire(path.join(workDir, 'lib', 'work-actions'), {
  appendAction: () => {},
});
const tp = tryRequire(path.join(libDir, 'ticket-provider'), null);
if (!tp) process.exit(0);

// ─── Configuration ──────────────────────────────────────────────────────────
const getConfig = require(path.join(libDir, 'get-config'));
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
  path.join(workDir, 'lib', 'work-helpers')
);
const { parseTicketInput, validateRawTicketInput } = require(path.join(libDir, 'ticket-provider'));
const { parseTasks, buildTaskPrompt } = require(path.join(workDir, 'lib', 'task-parser'));
const { archiveStepArtifacts } = require(path.join(workDir, 'lib', 'artifact-archival'));
const { getHeadSha } = require(path.join(workDir, 'lib', 'git-utils'));
const { TDD_PROTOCOL, readTddEvidence: _readTddEvidence, validateTddEvidence } = require(
  path.join(workDir, 'lib', 'tdd-enforcement')
);
const { inspect: _inspect } = require(path.join(workDir, 'engine', 'inspect'));
const { generatePlan: _generatePlan } = require(path.join(workDir, 'engine', 'plan-generator'));
const { transitionStep: _transitionStep } = require(
  path.join(workDir, 'engine', 'transition-step')
);
const { validateCheckGate: _validateCheckGate } = require(
  path.join(workDir, 'gates', 'check-gate')
);

// ─── Local modules ──────────────────────────────────────────────────────────
const { buildInstruction } = require(path.join(__dirname, 'lib', 'instruction-builder'));
const { buildStateContext } = require(path.join(__dirname, 'lib', 'state-context'));
const { writeMarkerFile } = require(path.join(__dirname, 'lib', 'marker'));
const { enrich, runGate } = require(path.join(__dirname, 'lib', 'step-enrichments'));
const { createDebugLog } = require(path.join(__dirname, 'lib', 'debug-log'));

// ─── Constants ──────────────────────────────────────────────────────────────
const TDD_GATED_STEPS = [STEPS.implement];
const { buildVerdictRegex } = require(path.join(__dirname, '..', 'lib', 'parse-completion-status'));
const REQUIRED_REPORTS = [
  { file: 'tests.check.md', passPattern: buildVerdictRegex(['APPROVED']) },
  { file: 'code-review.check.md', passPattern: buildVerdictRegex(['APPROVED']) },
  { file: 'completion.check.md', passPattern: buildVerdictRegex(['COMPLETE', 'APPROVED']) },
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
        const { resolveGitHead } = require(path.join(workDir, 'lib', 'git-utils'));
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

// ─── Active-session conflict detection ──────────────────────────────────────

/**
 * Detect whether the user-supplied ticket canonical conflicts with an existing
 * active session. Returns null on no conflict, or { canonical, reason } when
 * the caller should be blocked.
 *
 * Rules:
 *   - Input has suffix, no-suffix sibling state exists at tasks/<base>/.work-state.json → conflict
 *   - Input has no suffix, but a suffix-session exists at tasks/<base>/<suffix>/.work-state.json → conflict
 *   - Exact-match state (or no state at all) → no conflict
 */
function detectSessionConflict(validated, tasksBase, tp) {
  const fsLocal = require('fs');
  const pathLocal = require('path');
  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  const isGitHub = providerConfig?.provider === 'github';
  // Normalize ticketBase the same way getNextInstruction does, so the
  // filesystem path we probe matches the one used by state writers.
  // For GitHub, `GH-56` / `56` / `#56` all canonicalize to `#56` before
  // sanitization → `sanitizeTicketIdForPath('#56', ...)` (e.g. `GH-56`).
  let normalizedBase = validated.ticketBase.toUpperCase();
  if (
    isGitHub &&
    (/^#?\d+$/.test(validated.ticketBase) || /^GH-\d+$/i.test(validated.ticketBase))
  ) {
    const num = validated.ticketBase.replace(/^#|^GH-/i, '');
    normalizedBase = '#' + num;
  }
  const safeBase = tp.sanitizeTicketIdForPath(normalizedBase, providerConfig);
  const suffix = validated.suffix;
  const exactPath = pathLocal.join(
    tasksBase,
    suffix ? `${safeBase}/${suffix}` : safeBase,
    '.work-state.json'
  );
  if (fsLocal.existsSync(exactPath)) return null; // exact match — proceed
  if (suffix) {
    // Input has suffix; check for a bare-base session
    const baseStatePath = pathLocal.join(tasksBase, safeBase, '.work-state.json');
    if (fsLocal.existsSync(baseStatePath)) {
      return {
        canonical: safeBase,
        reason: `An active session exists for ${safeBase} (no suffix). Re-invoke with that exact canonical, or finish/abort it first.`,
      };
    }
  } else {
    // Input has no suffix; check for any suffix-session under tasks/<base>/
    const baseDir = pathLocal.join(tasksBase, safeBase);
    if (fsLocal.existsSync(baseDir)) {
      let entries;
      try {
        entries = fsLocal.readdirSync(baseDir, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const stateFile = pathLocal.join(baseDir, entry.name, '.work-state.json');
        if (fsLocal.existsSync(stateFile)) {
          // Read the existing session's recorded separator (if any) so the
          // `canonical` and `reason` fields are mutually consistent —
          // matching the form the session was originally created with.
          // Falls back to `-` (default re-invocation form).
          let existingSeparator = '-';
          try {
            const raw = fsLocal.readFileSync(stateFile, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && (parsed.ticketSeparator === '-' || parsed.ticketSeparator === '/')) {
              existingSeparator = parsed.ticketSeparator;
            }
          } catch {
            // ignore — fall back to '-'
          }
          const canonical = `${safeBase}${existingSeparator}${entry.name}`;
          return {
            canonical,
            reason: `An active session exists for ${canonical}. Re-invoke with: ${canonical}`,
          };
        }
      }
    }
  }
  return null;
}

// ─── Core Orchestration Loop ────────────────────────────────────────────────
// IMPORTANT: This file is the generic orchestrator. NO step-specific logic here.
// Step-specific behavior (prompts, gates, delegation overrides) belongs in
// lib/step-enrichments/ — registered via enrich() and runGate().

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

  // Parse + STRICT validate ticket input BEFORE any filesystem side effect.
  // This rejects malformed input like "ECHO-4446 TASKS" (whitespace), traversal,
  // or non-canonical bases — preventing creation of bogus tasks/ subfolders.
  const providerConfigEarly = tp.getProviderConfig({ skipPrompt: true });
  let ticketBase, suffix, separator;
  try {
    const validated = validateRawTicketInput(ticketRaw, providerConfigEarly);
    ticketBase = validated.ticketBase;
    suffix = validated.suffix;
    separator = validated.separator || null;
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
      suggestion:
        'Pass a canonical ticket ID like PROJ-123 (or PROJ-123-suffix). No spaces or path separators.',
    };
  }

  const providerConfig = providerConfigEarly;
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
      const sessionDir = process.env.SESSION_GUARD_DIR || require('os').tmpdir();
      const sanitizedId = String(safeBase).replace(/[/\\:\0]/g, '_');
      const sessionPath = path.join(sessionDir, `claude-session-guard-${sanitizedId}.json`);
      if (fs.existsSync(sessionPath)) {
        const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
        session.workflow = '/work';
        // Fix cwd to point to the worktree (not the calling cwd)
        const worktreeDir = path.join(WORKTREES_BASE, `${MAIN_WORKTREE_FOLDER}-${safeBase}`);
        session.cwd = worktreeDir;
        fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2));
      }
    } catch {
      /* fail-open */
    }
  }

  // Persist DEFER metadata. Also persist the canonical ticket identity
  // (ticketBase / ticketSuffix / ticketSeparator) so future invocations can
  // verify they're addressing the same session even if the user passes a
  // shortened or different variant.
  result.timestamp = new Date().toISOString();
  const planState = loadWorkState(safeName);
  if (planState) {
    planState.lastPlanTimestamp = result.timestamp;
    planState.deferredSteps = result.plan.filter((s) => s.action === 'DEFER').map((s) => s.step);
    // Backfill canonical identity on existing state from pre-this-fix sessions
    if (planState.ticketBase === undefined) planState.ticketBase = safeBase;
    if (planState.ticketSuffix === undefined) planState.ticketSuffix = suffix || null;
    if (planState.ticketSeparator === undefined) {
      // Use the separator the user actually typed (validateRawTicketInput
      // returns '-', '/', or null). Falling back to '/' only when a suffix
      // exists but the parser didn't report a separator — defensive only.
      planState.ticketSeparator = suffix ? separator || '/' : null;
    }
    saveWorkState(safeName, planState);
  } else {
    const deferSteps = result.plan.filter((s) => s.action === 'DEFER').map((s) => s.step);
    if (deferSteps.length > 0) {
      const minimalState = {
        ticketId: safeName,
        ticketBase: safeBase,
        ticketSuffix: suffix || null,
        ticketSeparator: suffix ? separator || '/' : null,
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
      appendAction(safeName, { step: STEPS.ticket, what: 'workflow started (work)' });
    }
  }

  const plan = result.plan;
  const tasksDir = path.join(TASKS_BASE, safeName);
  const log = createDebugLog(tasksDir);
  const args = process.argv.slice(2).join(' ');
  log.call(ticket, args);

  // GH-398 (ECHO-4552 Issue 2): dispatcher-level early-return when the
  // workflow is in the terminal completed state. Per brief P0 #1, fires on
  // `state.status === 'completed'` ALONE — older state files (and any state
  // where the overall status flag was set without back-filling
  // `stepStatus.complete`) must short-circuit. The "all steps completed
  // including the canonical complete step" case is independently handled by
  // existing `getCurrentStep() === 'complete'` checks elsewhere in the
  // codebase, so the looser condition here does not narrow coverage.
  const _preCheckState = loadWorkState(safeName);
  if (_preCheckState && _preCheckState.status === 'completed') {
    // Release session guard inline
    try {
      const sgPath = path.join(workDir, '..', 'lib', 'hooks', 'session-guard.js');
      execFileSync(process.execPath, [sgPath, 'finish', safeName], {
        encoding: 'utf8',
        timeout: 10000,
        stdio: 'pipe',
      });
    } catch {
      /* already released or not active */
    }
    return {
      type: 'work_instruction',
      action: 'complete',
      state: {
        ticket,
        currentStep: 'complete',
        progress: `${ALL_STEPS.length}/${ALL_STEPS.length}`,
        completedSteps: ALL_STEPS,
        remainingSteps: [],
      },
      summary: `Workflow ${safeName} already complete. Session released.`,
    };
  }

  // Short-circuit to `complete` when BOTH ci-phase.json is at `done` AND
  // `gh pr view` reports MERGED. Fail-open on gh errors; fail-closed on the
  // phase guard (missing or non-done ci-phase.json skips the short-circuit).
  if (_preCheckState && _preCheckState.status !== 'completed') {
    try {
      const ciPhasePath = path.join(TASKS_BASE, safeName, 'ci-phase.json');
      let ciPhase = null;
      try {
        ciPhase = JSON.parse(fs.readFileSync(ciPhasePath, 'utf8'));
      } catch {
        // missing/unreadable → short-circuit MUST NOT fire
      }
      if (!ciPhase || ciPhase.currentPhase !== 'done') {
        throw new Error('ci-phase.json not at terminal phase — skipping PR-merged probe');
      }
      const worktreeDir = path.join(WORKTREES_BASE, `${MAIN_WORKTREE_FOLDER}-${safeBase}`);
      // Skip the probe entirely when the worktree dir is missing. Falling back
      // to process.cwd() would run `gh pr view` against whatever branch happens
      // to be checked out there, potentially querying an unrelated ticket's PR
      // and destructively marking THIS ticket's state as completed.
      if (!fs.existsSync(worktreeDir)) {
        throw new Error('worktree directory missing — skipping PR-merged probe');
      }
      const ghOut = execFileSync('gh', ['pr', 'view', '--json', 'state'], {
        cwd: worktreeDir,
        encoding: 'utf8',
        timeout: 10000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const parsed = JSON.parse(ghOut);
      if (parsed && parsed.state === 'MERGED') {
        const merged = loadWorkState(safeName);
        if (merged) {
          merged.status = 'completed';
          merged.completedTime = new Date().toISOString();
          ALL_STEPS.forEach((s) => {
            if (!merged.stepStatus) merged.stepStatus = {};
            merged.stepStatus[s] = 'completed';
          });
          saveWorkState(safeName, merged);
        }
        // Release session guard (best-effort, same pattern as terminal short-circuit)
        try {
          const sgPath = path.join(workDir, '..', 'lib', 'hooks', 'session-guard.js');
          execFileSync(process.execPath, [sgPath, 'finish', safeName], {
            encoding: 'utf8',
            timeout: 10000,
            stdio: 'pipe',
          });
        } catch {
          /* already released or not active */
        }
        return {
          type: 'work_instruction',
          action: 'complete',
          state: {
            ticket,
            currentStep: 'complete',
            progress: `${ALL_STEPS.length}/${ALL_STEPS.length}`,
            completedSteps: ALL_STEPS,
            remainingSteps: [],
          },
          summary: `Workflow ${safeName} already complete (PR merged). Session released.`,
        };
      }
    } catch (err) {
      // Fail-open — any gh failure (non-zero exit, network, auth, JSON parse)
      // falls through to existing behavior. Trace to stderr when WORK2_DEBUG.
      if (process.env.WORK2_DEBUG) {
        process.stderr.write(
          `[work-next] gh pr view probe failed (fail-open): ${err?.message || String(err)}\n`
        );
      }
    }
  }

  // Debug logging (env-gated, stderr)
  const _dbgState = _preCheckState;
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
  log.state(currentStepName, workState?.stepStatus, workState?._work2Dispatched);

  // Helper: log and return instruction
  function returnInstruction(entry, ctx) {
    // Enrichments can override the entire instruction (e.g., brief_gate blocking for user input)
    if (entry._overrideInstruction) {
      log.instruction(entry._overrideInstruction);
      return entry._overrideInstruction;
    }
    const instr = buildInstruction(entry, ctx);
    log.instruction(instr);
    return instr;
  }

  // Enrichment context for step overrides
  const enrichCtx = { tasksDir, ticket, workDir, path, fs, tp, TASKS_BASE };

  for (const entry of plan) {
    if (entry.action === 'SKIP') continue;

    if (entry.action === 'RUN' || entry.action === 'DEFER') {
      const entryIdx = ALL_STEPS.indexOf(entry.step);

      // Pseudo-steps (e.g., 2b_transition) not in ALL_STEPS — execute directly
      log.step(entry.step, entry.action, entryIdx < 0 ? { pseudo: true } : null);
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
          return returnInstruction(entry, stateCtx);
        }
        continue;
      }

      // Skip steps behind current position
      if (currentStepIdx >= 0 && entryIdx < currentStepIdx) continue;

      // Current step — handle dispatched marker logic
      if (entry.step === currentStepName) {
        if (workState && workState._work2Dispatched === entry.step) {
          // Pre-transition gate: run BEFORE transitionStep to avoid hanging
          // on verify functions (e.g., isPRGateReady calls checkCI which blocks).
          // Gates like follow-up-gate and check-gate read sub-orchestrator state
          // and advance directly when their sub-workflow completed.
          // Compute the canonical worktree dir for this ticket so the gate's
          // test commands run inside the ticket's worktree — NOT whichever
          // shell cwd the PostToolUse hook happened to fire from. Cross-shell
          // invocations (one shell per worktree) used to leak: the gate would
          // run tests from worktree A but write evidence into ticket B.
          const worktreeDir = path.join(WORKTREES_BASE, `${MAIN_WORKTREE_FOLDER}-${safeBase}`);
          const preGateResult = runGate(
            entry.step,
            safeName,
            { ticket, stateCtx, tasksDir, worktreeDir },
            {
              loadWorkState,
              saveWorkState,
              readTddEvidence,
              validateTddEvidence,
              stepName: entry.step,
              workDir,
              work2Dir: __dirname,
              log,
              recursionDepth: _recursionDepth,
            }
          );
          if (preGateResult) {
            if (preGateResult.recurse) return getNextInstruction(ticketRaw, rework);
            return preGateResult;
          }

          // Gate didn't handle it — try standard transitions
          const allowed = (STEP_TRANSITIONS[entry.step] || []).filter(
            (t) => ALL_STEPS.indexOf(t) > ALL_STEPS.indexOf(entry.step)
          );
          for (const target of allowed) {
            const transResult = transitionStep(safeName, target);
            log.transition(
              entry.step,
              target,
              transResult?.error ? transResult.message : 'SUCCESS'
            );
            if (transResult && !transResult.error) {
              const ws = loadWorkState(safeName);
              if (ws) {
                delete ws._work2Dispatched;
                delete ws._work2DispatchedAction;
                saveWorkState(safeName, ws);
              }
              log.recurse(_recursionDepth, `advanced ${entry.step} → ${target}`);
              return getNextInstruction(ticketRaw, rework);
            }
          }
          log.error(`dispatch-advance BLOCKED for ${entry.step}`, { tried: allowed.length });

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
          return returnInstruction(entry, { ...stateCtx, currentStep: entry.step });
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
        return returnInstruction(entry, { ...stateCtx, currentStep: entry.step });
      }
      continue;
    }
  }

  // All steps done
  const completeInstr = {
    type: 'work_instruction',
    action: 'complete',
    state: stateCtx,
    summary: `All ${plan.length} steps done for ${ticket}`,
  };
  log.instruction(completeInstr);
  return completeInstr;
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
  // Take only the FIRST positional arg as the ticket. Multiple positionals
  // (e.g. "ECHO-4446 TASKS ECHO-4446") are an error — they would otherwise be
  // silently joined into "ECHO-4446 TASKS ECHO-4446" and create a bogus folder.
  const positionals = args.filter((a) => !a.startsWith('--'));
  const ticketRaw = (positionals[0] || '').trim();
  if (positionals.length > 1) {
    console.log(
      JSON.stringify(
        {
          type: 'work_instruction',
          action: 'blocked',
          reason: `Multiple positional arguments received: ${JSON.stringify(positionals)}. Pass exactly ONE ticket ID.`,
          suggestion: 'Quote suffixes: use APP-1234-foo (one arg), not APP-1234 foo (two args).',
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  // Validate BEFORE writeMarkerFile (which creates a tasks/<id>/ folder).
  // We re-validate inside getNextInstruction too, but the marker write happens
  // first under --init, so we must gate it here as well.
  let validated;
  try {
    const earlyProviderConfig = tp.getProviderConfig({ skipPrompt: true });
    validated = validateRawTicketInput(ticketRaw, earlyProviderConfig);
  } catch (err) {
    console.log(
      JSON.stringify(
        {
          type: 'work_instruction',
          action: 'blocked',
          reason: err.message,
          suggestion:
            'Pass a canonical ticket ID like PROJ-123 (or PROJ-123-suffix). No spaces or path separators.',
        },
        null,
        2
      )
    );
    process.exit(1);
  }

  // Active-session conflict check: once a session is bootstrapped, future
  // invocations MUST use the same canonical ID. Pass `APP-1234` when an active
  // session uses `APP-1234-foo` (or vice versa) → block.
  {
    const conflict = detectSessionConflict(validated, TASKS_BASE, tp);
    if (conflict) {
      console.log(
        JSON.stringify(
          {
            type: 'work_instruction',
            action: 'blocked',
            reason: conflict.reason,
            suggestion: `Re-invoke with: ${conflict.canonical}`,
          },
          null,
          2
        )
      );
      process.exit(1);
    }
  }

  // On --init, write marker file for auto-advance hook detection (stamped with
  // the owning session id + worktree root so hooks scope to this terminal).
  if (init) {
    writeMarkerFile(ticketRaw, { TASKS_BASE, tp });
  }

  const instruction = getNextInstruction(ticketRaw, rework);
  // Single-line JSON keeps stdout parseable by `JSON.parse(stdout.trim())`
  // and `stdout.slice(lastIndexOf('{'))` patterns used across tests; pretty-
  // printing introduces nested newlines that break the latter on multi-key
  // payloads (e.g. the terminal short-circuit's `state` block).
  console.log(JSON.stringify(instruction));
}

if (require.main === module) main();

module.exports = { getNextInstruction, buildStateContext, buildInstruction };
