#!/usr/bin/env node

/**
 * SubagentStop hook: Block developer agents from stopping without TDD evidence.
 *
 * Wired as SubagentStop in hooks.json (targets developer-* agents only).
 * When a developer agent tries to stop during the implement step,
 * this hook checks if TDD evidence exists for the current task.
 * If not, it blocks the stop and tells the agent the ONE next command to run.
 *
 * Skip conditions (exit 0):
 *   - WORK_TICKET_ID not set (not in implement step)
 *   - Task is a checkpoint type (exempt from TDD)
 *   - TDD evidence is valid (RED+GREEN cycle complete)
 *
 * Block conditions (exit 2):
 *   - TDD evidence missing or invalid
 *   - Outputs the single next command via tdd-next.js buildInstruction()
 *   - Logs the block to debug.md
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Read stdin (SubagentStop hook data) ────────────────────────────────────
// Prevent infinite loops: if stop_hook_active is set, another stop hook
// is already running — exit immediately to avoid re-entrance.
let _hookData = {};
try {
  const input = fs.readFileSync(0, 'utf-8');
  _hookData = JSON.parse(input);
} catch {
  /* empty/invalid — use default */
}
if (_hookData.stop_hook_active) {
  process.exit(0);
}

// ─── Detect ticket ID ────────────────────────────────────────────────────────
// Don't rely solely on WORK_TICKET_ID env var — detect from cwd/branch as fallback
let ticketId = process.env.WORK_TICKET_ID;
if (!ticketId) {
  try {
    const { getCurrentTaskId } = require(
      path.join(__dirname, '..', '..', 'lib', 'scripts', 'get-ticket-id')
    );
    ticketId = getCurrentTaskId();
  } catch {
    // Can't detect ticket — will exit below
  }
}

// ─── Debug logger ────────────────────────────────────────────────────────────
function debugLog(message) {
  try {
    const _getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
    const _tasksBase = _getConfig('TASKS_BASE');
    if (!_tasksBase || !ticketId) return;
    let _safeId = ticketId;
    try {
      _safeId = require(path.join(__dirname, '..', '..', 'lib', 'config')).safeTicketId(ticketId);
    } catch {
      _safeId = ticketId.replace(/[/\\:\0]/g, '_');
    }
    const debugPath = path.join(_tasksBase, _safeId, 'debug-tdd-hook.md');
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(debugPath, `${timestamp} | ${message}\n`);
  } catch {
    /* best-effort */
  }
}

if (!ticketId) {
  debugLog('SKIP: no WORK_TICKET_ID');
  process.exit(0);
}

// ─── Resolve paths ───────────────────────────────────────────────────────────

let TASKS_BASE;
try {
  const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
  TASKS_BASE = getConfig('TASKS_BASE');
} catch {
  debugLog('SKIP: no TASKS_BASE (config error)');
  process.exit(0); // can't resolve config — fail-open
}

if (!TASKS_BASE) {
  debugLog('SKIP: no TASKS_BASE');
  process.exit(0);
}

// Sanitize ticket ID for filesystem path
let safeTicket = ticketId;
try {
  const config = require(path.join(__dirname, '..', '..', 'lib', 'config'));
  safeTicket = config.safeTicketId(ticketId);
} catch {
  safeTicket = ticketId.replace(/[/\\:\0]/g, '_');
}

// ─── Get current task number from work state ─────────────────────────────────

let taskNum;
try {
  const wsPath = path.join(TASKS_BASE, safeTicket, '.work-state.json');
  const ws = JSON.parse(fs.readFileSync(wsPath, 'utf8'));

  // Only enforce during implement step
  const currentStep = ws.stepStatus
    ? Object.entries(ws.stepStatus).find(([, v]) => v === 'in_progress')?.[0]
    : null;
  if (currentStep !== 'implement') {
    debugLog('SKIP: step is not implement (step=' + currentStep + ')');
    process.exit(0);
  }

  if (!ws.tasksMeta || !Array.isArray(ws.tasksMeta.tasks)) {
    debugLog('SKIP: no tasksMeta');
    process.exit(0);
  }

  const idx = ws.tasksMeta.currentTaskIndex ?? 0;
  taskNum = Math.min(idx + 1, ws.tasksMeta.tasks.length) || undefined;
} catch {
  debugLog('SKIP: cannot read work state');
  process.exit(0); // can't read state — fail-open
}

if (!taskNum) {
  debugLog('SKIP: no taskNum');
  process.exit(0);
}

// ─── Skip checkpoint tasks ──────────────────────────────────────────────────

try {
  const { resolveTaskType } = require(
    path.join(__dirname, '..', '..', 'work', 'lib', 'resolve-task-type')
  );
  const tasksDir = path.join(TASKS_BASE, safeTicket);
  const taskType = resolveTaskType(tasksDir, taskNum);
  if (taskType === 'checkpoint') {
    debugLog('SKIP: checkpoint task');
    process.exit(0);
  }
} catch {
  // Can't resolve task type — continue with TDD check
}

// ─── Check TDD evidence ─────────────────────────────────────────────────────

let exists = false;
let valid = false;
try {
  const { readTddEvidence, validateTddEvidence } = require(
    path.join(__dirname, '..', '..', 'work', 'tdd-enforcement')
  );
  const result = readTddEvidence(safeTicket, 'implement', taskNum);
  exists = result.exists;
  if (exists) {
    valid = validateTddEvidence(result.evidence).valid;
  }
} catch {
  debugLog('SKIP: evidence check failed');
  process.exit(0); // can't check evidence — fail-open
}

if (exists && valid) {
  debugLog('PASS: evidence valid, allow stop');
  process.exit(0); // evidence valid — allow stop
}

// ─── Auto-run test command from tasks.md ─────────────────────────────────────

const { execFileSync, execSync } = require('child_process');
const tasksDir = path.join(TASKS_BASE, safeTicket);

let testCommand = null;
try {
  const { parseTasks } = require(path.join(__dirname, '..', '..', 'work', 'task-parser'));
  const tasks = parseTasks(tasksDir);
  const currentTask = tasks?.find((t) => t.num === taskNum);
  testCommand = currentTask?.testCommand || null;
} catch {
  // Can't parse tasks — fall through to manual block
}

if (testCommand) {
  debugLog('AUTO-RUN: test command found: ' + testCommand);
  const tddStatePath = path.join(__dirname, '..', 'tdd-phase-state.js');
  const tddEnv = { ...process.env, WORK_TDD_TOKEN_SKIP: '1' };
  const execOpts = { encoding: 'utf-8', timeout: 300000, stdio: 'pipe', env: tddEnv };

  // Read current phase
  let currentPhase = 'red';
  try {
    const { readPhase } = require(path.join(__dirname, '..', '..', 'work', 'tdd-next'));
    const phase = readPhase(safeTicket, taskNum);
    currentPhase = phase?.currentPhase || 'red';
  } catch {
    // Default to red
  }

  // Init if no state exists
  if (currentPhase === 'red' && !exists) {
    try {
      execFileSync(
        process.execPath,
        [tddStatePath, 'init', safeTicket, '--task', String(taskNum)],
        execOpts
      );
    } catch {
      // Init may already exist — continue
    }
  }

  // Apply phase-aware test flags:
  //   RED:   run ALL tests (need full failure picture)
  //   GREEN/REFACTOR: fail-fast on first failure (no point running rest)
  let phaseTestCommand = testCommand;
  if (currentPhase === 'green' || currentPhase === 'refactor') {
    // Append fail-fast flags for common test runners
    // vitest/jest: --bail    playwright: already fails fast by default
    // Only append if not already present
    if (!/--bail\b/.test(phaseTestCommand)) {
      phaseTestCommand = phaseTestCommand.replace(
        /(pnpm\s+test(?::unit|:integration)?)/g,
        '$1 --bail'
      );
    }
  }

  // Run test command and record evidence through the authorized writer.
  // The hook MUST NOT write phase state directly — tdd-phase-state.js is the
  // sole writer. Previous fabrication path (RED+GREEN written directly when
  // tests passed in RED) caused agent/state divergence: agent thought "I haven't
  // done the cycle yet" while disk said "cycle complete" (ECHO-4581 burned 1h+
  // looping on this divergence). If tests pass in RED, that means either the
  // agent skipped writing the failing test or the test was already passing —
  // both require agent intervention, not silent fabrication.
  const effectivePhase = currentPhase;
  if (currentPhase === 'red') {
    try {
      require('child_process').execSync(phaseTestCommand, {
        encoding: 'utf-8',
        timeout: 300000,
        stdio: 'pipe',
        cwd: process.cwd(),
      });
      // Tests passed in RED — block the stop with a clear instruction. Do NOT
      // fabricate GREEN. The agent must reconcile: either record a real failing
      // test (RED), or call task-next.js to get the next instruction.
      process.stderr.write(
        [
          '',
          'STOP BLOCKED: RED phase has no failing-test evidence yet, but the',
          'current test command exits 0. This means one of:',
          '  (a) You skipped writing the failing test first.',
          '  (b) The test was already passing before this cycle started.',
          '  (c) You implemented the production code before recording RED.',
          '',
          'The hook will NOT fabricate evidence for you — that would corrupt the',
          'TDD audit trail (see RC-C in implement-gate stuckness investigation).',
          '',
          'What to do:',
          `  Run: node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-implement/task-next.js ${safeTicket} task${taskNum}`,
          '  It will tell you precisely which phase you are in and what to do next.',
          '',
        ].join('\n')
      );
      debugLog('STOP BLOCKED: tests passed in RED, refused to fabricate evidence');
      process.exit(2); // block the stop — agent must call task-next.js
    } catch {
      // Tests failed — good, RED phase is correct. Fall through to record-red.
      debugLog('AUTO-RUN: tests failed in RED phase (expected)');
    }
  }

  try {
    execFileSync(
      process.execPath,
      [
        tddStatePath,
        `record-${effectivePhase}`,
        safeTicket,
        '--task',
        String(taskNum),
        '--cmd',
        phaseTestCommand,
      ],
      execOpts
    );

    // Transition to next phase
    const nextPhase = { red: 'green', green: 'refactor', refactor: 'red' }[currentPhase];
    if (nextPhase && nextPhase !== 'red') {
      try {
        execFileSync(
          process.execPath,
          [tddStatePath, 'transition', safeTicket, nextPhase, '--task', String(taskNum)],
          execOpts
        );
      } catch {
        // Transition may fail if already at target phase
      }
    }

    // Log success
    try {
      const debugPath = path.join(TASKS_BASE, safeTicket, 'debug.md');
      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      fs.appendFileSync(
        debugPath,
        `\n## ${timestamp} — enforce-tdd-on-stop\n\n- **[AUTO-RECORDED]** task ${taskNum}: ${currentPhase} phase recorded via test command\n`
      );
    } catch {
      /* best-effort */
    }

    // If we recorded GREEN or REFACTOR, allow stop
    if (effectivePhase === 'green' || effectivePhase === 'refactor') {
      debugLog('PASS: ' + effectivePhase + ' recorded, allow stop');
      process.exit(0);
    }

    // RED recorded — tests fail, block agent to fix them
    debugLog('BLOCK: RED recorded, tests failing');
    process.stderr.write(`TDD: RED phase recorded for task ${taskNum} — tests are failing.\n`);
    process.stderr.write(`Fix the failing tests, then try to stop again.\n`);
    process.exit(2);
  } catch (err) {
    // record-* failed — likely test command error or phase mismatch
    const msg = err.stderr || err.stdout || err.message || 'unknown';
    try {
      const debugPath = path.join(TASKS_BASE, safeTicket, 'debug.md');
      const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
      fs.appendFileSync(
        debugPath,
        `\n## ${timestamp} — enforce-tdd-on-stop\n\n- **[AUTO-RUN FAILED]** task ${taskNum}: ${currentPhase} phase — ${String(msg).substring(0, 200)}\n`
      );
    } catch {
      /* best-effort */
    }

    // Test command exists but recording failed — block the agent
    debugLog('BLOCK: recording failed');
    process.stderr.write(`BLOCKED: TDD evidence recording failed for task ${taskNum}.\n`);
    process.stderr.write(`Test command: ${testCommand}\n`);
    process.stderr.write(`Fix the issue and try stopping again.\n`);
    process.exit(2);
  }
}

// ─── No test command in tasks.md — allow stop (bypass evidence) ──────────────
// Gate-driven TDD requires ### Test Command in tasks.md. If missing, the task
// was created before this feature or the split-in-tasks agent didn't include it.
// Allow the agent to stop — evidence verification is skipped for tasks without
// a test command.

try {
  const debugPath = path.join(TASKS_BASE, safeTicket, 'debug.md');
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  fs.appendFileSync(
    debugPath,
    `\n## ${timestamp} — enforce-tdd-on-stop\n\n- **[BYPASS]** task ${taskNum}: No ### Test Command in tasks.md — evidence check skipped\n`
  );
} catch {
  // fail-open
}

debugLog('BYPASS: no test command in tasks.md');
process.exit(0);
