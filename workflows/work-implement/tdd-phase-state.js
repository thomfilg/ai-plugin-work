#!/usr/bin/env node

/**
 * tdd-phase-state.js
 *
 * CLI script for managing TDD phase state.
 * This is the ONLY way evidence gets recorded — agents never self-report.
 *
 * Scope boundary (GH-212):
 *   REFACTOR evidence recorded here is developer self-cleanup only. The
 *   external review gate (/tests-review + /code-review) is NOT part of
 *   REFACTOR and is NOT invoked by this CLI. The post-commit review gate
 *   lives in workflows/work/steps/task-review.js (GH-211) and runs after
 *   the commit step, against the committed diff. Keeping reviews out of
 *   the TDD phase state machine means the normal TDD loop preserves the
 *   clean RED / GREEN / REFACTOR flow, while exception handling remains
 *   an out-of-band state, and ensures reviewers never see
 *   half-refactored work.
 *
 * Usage:
 *   node tdd-phase-state.js init <TICKET_ID>
 *   node tdd-phase-state.js current <TICKET_ID>
 *   node tdd-phase-state.js record-red <TICKET_ID> --cmd "<test command>"
 *   node tdd-phase-state.js record-green <TICKET_ID> --cmd "<test command>"
 *   node tdd-phase-state.js record-refactor <TICKET_ID> --cmd "<test command>"
 *   node tdd-phase-state.js transition <TICKET_ID> <target_phase>
 *   node tdd-phase-state.js exception <TICKET_ID> --category <category> --reason "<reason>"
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { tddCanTransition, isTestFile } = require('./tdd-phase-registry');
const { consumeToken, tokenPath } = require('../lib/scripts/write-report');
const { normalizeAgentName } = require('../lib/agent-detection');

let config;
try {
  config = require('../lib/config');
} catch (e) {
  if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
  config = null;
}

// Agents authorized to call gated subcommands
const ALLOWED_AGENTS = [
  'developer-nodejs-tdd',
  'developer-react-senior',
  'developer-react-ui-architect',
  'developer-devops',
];

// Subcommands that require token verification
const GATED_SUBCOMMANDS = [
  'record-red',
  'record-green',
  'record-refactor',
  'transition',
  'exception',
];

const TOKEN_MAX_AGE_MS = 10_000; // 10 seconds

// ─── Helpers ────────────────────────────────────────────────────────────────

function sanitizeId(ticketId) {
  try {
    return require('../lib/config').safeTicketId(ticketId);
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
    return ticketId;
  }
}

/**
 * Resolve TASKS_BASE from env, config, or HOME fallback.
 * @returns {string}
 */
function resolveTasksBase() {
  return (
    process.env.TASKS_BASE ||
    (config && config.TASKS_BASE) ||
    path.join(require('os').homedir(), 'worktrees', 'tasks')
  );
}

/**
 * Build the per-task state path: TASKS_BASE/<ticket>/task${N}/tdd-phase.json
 * @param {string} base - Resolved TASKS_BASE
 * @param {string} safeId - Sanitized ticket ID
 * @param {number} taskNum - Task number (positive integer)
 * @returns {string}
 */
function perTaskStatePath(base, safeId, taskNum) {
  let taskSegmentFn;
  try {
    taskSegmentFn = require('../lib/allocate-output-folder').taskSegment;
  } catch (e) {
    if (e && e.code !== 'MODULE_NOT_FOUND') throw e;
    // fallback if allocator not available — inline the task${N} pattern
    taskSegmentFn = (n) => `task${n}`;
  }
  return path.resolve(base, safeId, taskSegmentFn(taskNum), 'tdd-phase.json');
}

/**
 * Build the legacy ticket-root state path: TASKS_BASE/<ticket>/tdd-phase.json
 * @param {string} base - Resolved TASKS_BASE
 * @param {string} safeId - Sanitized ticket ID
 * @returns {string}
 */
function ticketRootStatePath(base, safeId) {
  return path.resolve(base, safeId, 'tdd-phase.json');
}

/**
 * Resolve the state file path for a ticket.
 *
 * When taskNum is provided:
 *   - Always uses per-task path (TASKS_BASE/<ticket>/task${N}/tdd-phase.json).
 *   - No fallback to legacy root (GH-219 Task 1).
 *
 * When taskNum is NOT provided:
 *   - Uses the legacy root path (backward compat).
 *
 * @param {string} ticketId - Raw ticket ID
 * @param {object} [opts] - Options
 * @param {number} [opts.taskNum] - Task number for per-task resolution
 * @returns {string} Absolute path to tdd-phase.json
 */
function getStatePath(ticketId, opts) {
  if (!ticketId || /\.\.|[\\:\x00]/.test(ticketId)) {
    throw new Error(`Invalid ticket ID: ${ticketId}`);
  }
  const base = resolveTasksBase();
  const safeId = sanitizeId(ticketId);
  const taskNum = opts && opts.taskNum;

  let resolved;

  if (taskNum != null && Number.isInteger(taskNum) && taskNum > 0) {
    const perTask = perTaskStatePath(base, safeId, taskNum);

    // Per-task path — always use it, no legacy root fallback (GH-219 Task 1)
    resolved = perTask;
  } else {
    // No task number — legacy root path
    resolved = ticketRootStatePath(base, safeId);
  }

  // Validate resolved path stays within TASKS_BASE (prevents traversal)
  if (!resolved.startsWith(path.resolve(base) + path.sep)) {
    throw new Error(`Invalid ticket ID: ${ticketId}`);
  }
  return resolved;
}

function readState(ticketId, opts) {
  const statePath = getStatePath(ticketId, opts);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function writeState(ticketId, state, opts) {
  const statePath = getStatePath(ticketId, { ...opts, forWrite: true });
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  try {
    fs.unlinkSync(statePath);
  } catch (e) {
    if (e && e.code !== 'ENOENT') throw e;
  }
  fs.renameSync(tmpPath, statePath);
}

function errorExit(message) {
  process.stderr.write(JSON.stringify({ error: true, message }) + '\n');
  process.exit(1);
}

function successOut(data) {
  process.stdout.write(JSON.stringify(data) + '\n');
}

// Commands that are NOT real test runners — used to fake TDD evidence
const FAKE_CMD_PATTERNS = [
  /^\s*exit\s+\d/i, // exit 1
  /^\s*echo\b/i, // echo anything
  /^\s*true\s*$/i, // true
  /^\s*false\s*$/i, // false
  /^\s*:\s*$/i, // : (no-op)
  /^\s*test\s+-[a-z]\s/i, // test -f (file tests, not test runners)
  /^\s*\/bin\/(true|false)\s*$/i, // /bin/true, /bin/false
];

function parseCmd(args) {
  const cmdIdx = args.indexOf('--cmd');
  if (cmdIdx === -1 || cmdIdx + 1 >= args.length) {
    return null;
  }
  const cmd = args[cmdIdx + 1];

  // Block fake/dummy test commands
  if (FAKE_CMD_PATTERNS.some((re) => re.test(cmd))) {
    errorExit(
      `Fake test command detected: "${cmd}". ` +
        'The --cmd argument must be a real test runner (e.g., "pnpm test", "npx vitest", "node --test").'
    );
  }

  return cmd;
}

function parseTask(args) {
  const taskIdx = args.indexOf('--task');
  if (taskIdx === -1 || taskIdx + 1 >= args.length) {
    return undefined;
  }
  const val = parseInt(args[taskIdx + 1], 10);
  if (!Number.isInteger(val) || val < 1)
    throw new Error('Invalid --task value: ' + args[taskIdx + 1]);
  return val;
}

function safeParseTask(args) {
  try {
    return parseTask(args);
  } catch (e) {
    errorExit(e.message);
  }
}

function parseCategory(args) {
  const idx = args.indexOf('--category');
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function runTestCommand(cmd) {
  try {
    execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000 });
    return 0;
  } catch (err) {
    if (err.killed) {
      process.stderr.write(`Test command timed out after 5 minutes: ${cmd}\n`);
    }
    return err.status || 1;
  }
}

function getCurrentCycleRecord(state) {
  let record = state.cycles.find((c) => c.cycle === state.currentCycle);
  if (!record) {
    record = { cycle: state.currentCycle };
    state.cycles.push(record);
  }
  return record;
}

// ─── Token Verification ─────────────────────────────────────────────────────

function verifyToken() {
  const scriptBasename = path.basename(__filename);
  const token = consumeToken(scriptBasename);

  if (!token) {
    errorExit(
      "No valid write token found. This script can only be called through Claude Code's agent system."
    );
  }

  if (typeof token.timestamp !== 'number' || !Number.isFinite(token.timestamp)) {
    errorExit('Token has invalid or missing timestamp.');
  }

  if (typeof token.agent !== 'string' || !token.agent) {
    errorExit('Token has invalid or missing agent field.');
  }

  const age = Date.now() - token.timestamp;
  // Reject future timestamps (clock skew or replay attack)
  if (age < 0) {
    errorExit(`Write token timestamp is in the future (${Math.abs(age)}ms ahead).`);
  }
  if (age > TOKEN_MAX_AGE_MS) {
    errorExit(`Write token expired (${age}ms old, max ${TOKEN_MAX_AGE_MS}ms).`);
  }

  const agentMatch = ALLOWED_AGENTS.some(
    (a) => normalizeAgentName(a) === normalizeAgentName(token.agent)
  );

  if (!agentMatch) {
    errorExit(
      `Token agent "${token.agent}" is not authorized. Allowed: ${ALLOWED_AGENTS.join(', ')}`
    );
  }
}

// ─── Subcommands ────────────────────────────────────────────────────────────

function cmdInit(ticketId, args) {
  if (!ticketId) {
    errorExit('Missing ticket ID. Usage: node tdd-phase-state.js init <TICKET_ID>');
  }
  const taskNum = safeParseTask(args || []);
  const opts = taskNum ? { taskNum } : undefined;
  const state = {
    currentPhase: 'red',
    currentCycle: 1,
    cycles: [],
  };
  writeState(ticketId, state, opts);
  successOut({ ok: true, phase: 'red', cycle: 1 });
}

function cmdCurrent(ticketId, args) {
  if (!ticketId) {
    errorExit('Missing ticket ID.');
  }
  const taskNum = safeParseTask(args || []);
  const opts = taskNum ? { taskNum } : undefined;
  const state = readState(ticketId, opts);
  if (!state) {
    errorExit('No TDD phase state found. Run "init" first.');
  }
  successOut({ phase: state.currentPhase, cycle: state.currentCycle });
}

function cmdRecordRed(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  const cmd = parseCmd(args);
  if (!cmd) errorExit('Missing --cmd argument.');
  const taskNum = safeParseTask(args);
  const opts = taskNum ? { taskNum } : undefined;

  const state = readState(ticketId, opts); // reads per-task path when taskNum provided
  if (!state) errorExit('No TDD phase state found. Run "init" first.');
  // Enforce phase consistency: record-red only allowed during red phase
  if (state.currentPhase !== 'red')
    errorExit(
      'Cannot record RED evidence: current phase is "' +
        state.currentPhase +
        '". Transition to red first.'
    );

  // Detect changed test files via git diff
  let allChanged = [];
  try {
    const diff = execSync('git diff --name-only', { encoding: 'utf8' }).trim();
    const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
    const untracked = execSync('git ls-files --others --exclude-standard', {
      encoding: 'utf8',
    }).trim();
    allChanged = [
      ...new Set(
        [...diff.split('\n'), ...staged.split('\n'), ...untracked.split('\n')].filter(Boolean)
      ),
    ];
  } catch {
    // git not available or not a repo
  }
  const testFiles = allChanged.filter((f) => isTestFile(f));

  if (testFiles.length === 0) {
    errorExit('No test files changed. RED phase requires modified .test or .spec files.');
  }

  // Run tests — they must FAIL
  const exitCode = runTestCommand(cmd);
  if (exitCode === 0) {
    errorExit('Tests must FAIL in RED phase. Tests passed (exit 0).');
  }

  // Record evidence
  const record = getCurrentCycleRecord(state);
  record.red = {
    testFiles,
    testCommand: cmd,
    testExitCode: exitCode,
    timestamp: new Date().toISOString(),
  };
  writeState(ticketId, state, opts);
  successOut({
    ok: true,
    phase: 'red',
    cycle: state.currentCycle,
    testFiles,
    testExitCode: exitCode,
  });
}

function cmdRecordGreen(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  const cmd = parseCmd(args);
  if (!cmd) errorExit('Missing --cmd argument.');
  const taskNum = safeParseTask(args);
  const opts = taskNum ? { taskNum } : undefined;

  const state = readState(ticketId, opts);
  if (!state) errorExit('No TDD phase state found. Run "init" first.');
  // Enforce phase consistency: record-green only allowed during green phase
  if (state.currentPhase !== 'green')
    errorExit(
      'Cannot record GREEN evidence: current phase is "' +
        state.currentPhase +
        '". Transition to green first.'
    );

  const exitCode = runTestCommand(cmd);
  if (exitCode !== 0) {
    errorExit('Tests must PASS in GREEN phase. Tests failed (exit ' + exitCode + ').');
  }

  const record = getCurrentCycleRecord(state);
  record.green = {
    testCommand: cmd,
    testExitCode: exitCode,
    timestamp: new Date().toISOString(),
  };
  writeState(ticketId, state, opts);
  successOut({ ok: true, phase: 'green', cycle: state.currentCycle, testExitCode: exitCode });
}

// cmdRecordRefactor: records re-run evidence only; does NOT invoke
// /tests-review or /code-review. Those reviewer commands run as a separate
// post-commit gate owned by workflows/work/steps/task-review.js (GH-211),
// not by this CLI and not by the developer agent driving the TDD loop.
function cmdRecordRefactor(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  const cmd = parseCmd(args);
  if (!cmd) errorExit('Missing --cmd argument.');
  const taskNum = safeParseTask(args);
  const opts = taskNum ? { taskNum } : undefined;

  const state = readState(ticketId, opts);
  if (!state) errorExit('No TDD phase state found. Run "init" first.');
  // Enforce phase consistency: record-refactor only allowed during refactor phase
  if (state.currentPhase !== 'refactor')
    errorExit(
      'Cannot record REFACTOR evidence: current phase is "' +
        state.currentPhase +
        '". Transition to refactor first.'
    );

  const exitCode = runTestCommand(cmd);
  if (exitCode !== 0) {
    errorExit('Tests must still PASS after refactoring. Tests failed (exit ' + exitCode + ').');
  }

  const record = getCurrentCycleRecord(state);
  record.refactor = {
    testCommand: cmd,
    testExitCode: exitCode,
    timestamp: new Date().toISOString(),
  };
  writeState(ticketId, state, opts);
  successOut({ ok: true, phase: 'refactor', cycle: state.currentCycle, testExitCode: exitCode });
}

function cmdTransition(ticketId, targetPhase, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  if (!targetPhase) errorExit('Missing target phase.');
  const taskNum = safeParseTask(args || []);
  const opts = taskNum ? { taskNum } : undefined;

  const state = readState(ticketId, opts);
  if (!state) errorExit('No TDD phase state found. Run "init" first.');

  // Validate transition
  if (!tddCanTransition(state.currentPhase, targetPhase)) {
    errorExit(
      `Invalid transition: ${state.currentPhase} -> ${targetPhase}. ` +
        `Valid transitions: red->green, green->refactor, refactor->red.`
    );
  }

  // Validate evidence exists for current phase
  const currentCycleRecord = state.cycles.find((c) => c.cycle === state.currentCycle);
  if (!currentCycleRecord || !currentCycleRecord[state.currentPhase]) {
    errorExit(
      `No evidence recorded for ${state.currentPhase} phase. ` +
        `Run "record-${state.currentPhase}" first.`
    );
  }

  // Update phase
  state.currentPhase = targetPhase;

  // If transitioning refactor -> red, increment cycle
  if (targetPhase === 'red') {
    state.currentCycle += 1;
  }

  writeState(ticketId, state, opts);
  successOut({ phase: state.currentPhase, cycle: state.currentCycle });
}

function auditException(ticketId, taskNum, category, reason, allow) {
  try {
    const { appendEnforcementAudit } = require('../work/work-actions');
    appendEnforcementAudit(ticketId, {
      origin: 'ai-subtask',
      task: taskNum || null,
      phase: null,
      action: 'tdd-exception',
      allow,
      reason: (category || 'unknown') + ': ' + (reason || ''),
      outputPath: null,
      meta: { category },
    });
  } catch {
    /* fail-open */
  }
}

function cmdException(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');

  // Parse --category (required)
  const category = parseCategory(args);
  const taskNum = safeParseTask(args);
  if (!category) {
    auditException(ticketId, taskNum, null, null, false);
    errorExit(
      'Missing --category argument. Usage: node tdd-phase-state.js exception <TICKET_ID> --category <category> --reason "<reason>"'
    );
  }

  // Validate category
  const { validateExceptionCategory, checkNewExportedCode } = require('./exception-validator');
  const catResult = validateExceptionCategory(category);
  if (!catResult.valid) {
    auditException(ticketId, taskNum, category, null, false);
    errorExit('Invalid exception category: ' + catResult.reason);
  }

  // Validate checkpoint category against actual task metadata
  if (category === 'checkpoint') {
    if (!taskNum) {
      auditException(ticketId, null, category, null, false);
      errorExit(
        'Category "checkpoint" requires --task <N> to identify which task is a checkpoint.'
      );
    }
    const { isCheckpointTask } = require('./exception-validator');
    const resolvedTasksBase = resolveTasksBase();
    const safeId = sanitizeId(ticketId);
    if (!isCheckpointTask(safeId, taskNum, resolvedTasksBase)) {
      auditException(ticketId, taskNum, category, null, false);
      errorExit(
        'Category "checkpoint" is only allowed for checkpoint tasks. Task ' +
          taskNum +
          ' is not a checkpoint task.'
      );
    }
  }

  // Parse --reason (required)
  const reasonIdx = args.indexOf('--reason');
  if (reasonIdx === -1 || reasonIdx + 1 >= args.length) {
    auditException(ticketId, taskNum, category, null, false);
    errorExit('Missing --reason argument.');
  }
  const reason = args[reasonIdx + 1];
  if (!reason || !reason.trim()) {
    auditException(ticketId, taskNum, category, '', false);
    errorExit('Reason cannot be empty.');
  }

  const opts = taskNum ? { taskNum } : undefined;

  // Heuristic check: detect new exported code (skip for checkpoint and file-move)
  if (category !== 'checkpoint' && category !== 'file-move') {
    let allChanged = [];
    try {
      const repoRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
      const gitOpts = { encoding: 'utf8', cwd: repoRoot };
      const diff = execSync('git diff --diff-filter=A --name-only', gitOpts).trim();
      const staged = execSync('git diff --cached --diff-filter=A --name-only', gitOpts).trim();
      const untracked = execSync('git ls-files --others --exclude-standard', gitOpts).trim();
      const relFiles = [
        ...new Set(
          [...diff.split('\n'), ...staged.split('\n'), ...untracked.split('\n')].filter(Boolean)
        ),
      ];
      allChanged = relFiles.map((f) => path.resolve(repoRoot, f));
    } catch {
      auditException(ticketId, taskNum, category, reason, false);
      errorExit(
        'Unable to verify exception eligibility: git repository detection failed. Run this command from within the repository so new-export checks can be enforced.'
      );
    }

    const exportCheck = checkNewExportedCode(allChanged);
    if (exportCheck.hasNewExports) {
      auditException(ticketId, taskNum, category, reason, false);
      errorExit(
        'New exported code detected in: ' +
          exportCheck.files.join(', ') +
          '. TDD is required for new code with exports. Use the RED-GREEN-REFACTOR cycle instead of exception mode.'
      );
    }
  }

  // Write structured exception
  const state = {
    currentPhase: 'exception',
    exception: { category, reason },
    cycles: [],
  };
  writeState(ticketId, state, opts);

  auditException(ticketId, taskNum, category, reason, true);

  successOut({ ok: true, phase: 'exception', category, reason });
}

// ─── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const subcommand = args[0];
const ticketId = args[1];

// Token gating: enforce-step-workflow.js Rule 5 issues tokens via AGENT_GATED_SCRIPTS
// where tdd-phase-state.js is registered with developer-* agents authorized.
// WORK_TDD_TOKEN_SKIP=1 bypasses verification for standalone/debugging use.
if (GATED_SUBCOMMANDS.includes(subcommand) && process.env.WORK_TDD_TOKEN_SKIP !== '1') {
  verifyToken();
}

switch (subcommand) {
  case 'init':
    cmdInit(ticketId, args.slice(2));
    break;
  case 'current':
    cmdCurrent(ticketId, args.slice(2));
    break;
  case 'record-red':
    cmdRecordRed(ticketId, args.slice(2));
    break;
  case 'record-green':
    cmdRecordGreen(ticketId, args.slice(2));
    break;
  case 'record-refactor':
    cmdRecordRefactor(ticketId, args.slice(2));
    break;
  case 'transition':
    cmdTransition(ticketId, args[2], args.slice(2));
    break;
  case 'exception':
    cmdException(ticketId, args.slice(2));
    break;
  default:
    errorExit(
      `Unknown subcommand: ${subcommand}. ` +
        'Valid: init, current, record-red, record-green, record-refactor, transition, exception'
    );
}
