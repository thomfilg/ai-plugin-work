#!/usr/bin/env node

/**
 * tdd-phase-state.js
 *
 * CLI script for managing TDD phase state.
 * This is the ONLY way evidence gets recorded — agents never self-report.
 *
 * Usage:
 *   node tdd-phase-state.js init <TICKET_ID>
 *   node tdd-phase-state.js current <TICKET_ID>
 *   node tdd-phase-state.js record-red <TICKET_ID> --cmd "<test command>"
 *   node tdd-phase-state.js record-green <TICKET_ID> --cmd "<test command>"
 *   node tdd-phase-state.js record-refactor <TICKET_ID> --cmd "<test command>"
 *   node tdd-phase-state.js transition <TICKET_ID> <target_phase>
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { tddCanTransition, isTestFile } = require('./tdd-phase-registry');
const { consumeToken, tokenPath } = require('../lib/scripts/write-report');
const { normalizeAgentName } = require('../lib/agent-detection');

// Agents authorized to call gated subcommands
const ALLOWED_AGENTS = ['developer-nodejs-tdd', 'developer-react-senior', 'developer-react-ui-architect', 'developer-devops'];

// Subcommands that require token verification
const GATED_SUBCOMMANDS = ['record-red', 'record-green', 'record-refactor', 'transition'];

const TOKEN_MAX_AGE_MS = 10_000; // 10 seconds

// ─── Helpers ────────────────────────────────────────────────────────────────

function getStatePath(ticketId) {
  return path.join(process.env.HOME, 'worktrees', 'tasks', ticketId, 'tdd-phase.json');
}

function readState(ticketId) {
  const statePath = getStatePath(ticketId);
  if (!fs.existsSync(statePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function writeState(ticketId, state) {
  const statePath = getStatePath(ticketId);
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = statePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(state, null, 2));
  fs.renameSync(tmpPath, statePath);
}

function errorExit(message) {
  process.stderr.write(JSON.stringify({ error: true, message }) + '\n');
  process.exit(1);
}

function successOut(data) {
  process.stdout.write(JSON.stringify(data) + '\n');
}

function parseCmd(args) {
  const cmdIdx = args.indexOf('--cmd');
  if (cmdIdx === -1 || cmdIdx + 1 >= args.length) {
    return null;
  }
  return args[cmdIdx + 1];
}

function runTestCommand(cmd) {
  try {
    execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return 0;
  } catch (err) {
    return err.status || 1;
  }
}

function getCurrentCycleRecord(state) {
  let record = state.cycles.find(c => c.cycle === state.currentCycle);
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
    errorExit('No valid write token found. This script can only be called through Claude Code\'s agent system.');
  }

  if (typeof token.timestamp !== 'number' || !Number.isFinite(token.timestamp)) {
    errorExit('Token has invalid or missing timestamp.');
  }

  if (typeof token.agent !== 'string' || !token.agent) {
    errorExit('Token has invalid or missing agent field.');
  }

  const age = Date.now() - token.timestamp;
  if (age > TOKEN_MAX_AGE_MS) {
    errorExit(`Write token expired (${age}ms old, max ${TOKEN_MAX_AGE_MS}ms).`);
  }

  const agentMatch = ALLOWED_AGENTS.some(
    a => normalizeAgentName(a) === normalizeAgentName(token.agent)
  );

  if (!agentMatch) {
    errorExit(`Token agent "${token.agent}" is not authorized. Allowed: ${ALLOWED_AGENTS.join(', ')}`);
  }
}

// ─── Subcommands ────────────────────────────────────────────────────────────

function cmdInit(ticketId) {
  if (!ticketId) {
    errorExit('Missing ticket ID. Usage: node tdd-phase-state.js init <TICKET_ID>');
  }
  const state = {
    currentPhase: 'red',
    currentCycle: 1,
    cycles: [],
  };
  writeState(ticketId, state);
  successOut({ ok: true, phase: 'red', cycle: 1 });
}

function cmdCurrent(ticketId) {
  if (!ticketId) {
    errorExit('Missing ticket ID.');
  }
  const state = readState(ticketId);
  if (!state) {
    errorExit('No TDD phase state found. Run "init" first.');
  }
  successOut({ phase: state.currentPhase, cycle: state.currentCycle });
}

function cmdRecordRed(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  const cmd = parseCmd(args);
  if (!cmd) errorExit('Missing --cmd argument.');

  const state = readState(ticketId);
  if (!state) errorExit('No TDD phase state found. Run "init" first.');

  // Detect changed test files via git diff
  let allChanged = [];
  try {
    const diff = execSync('git diff --name-only', { encoding: 'utf8' }).trim();
    const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' }).trim();
    allChanged = [...new Set([...diff.split('\n'), ...staged.split('\n')].filter(Boolean))];
  } catch {
    // git not available or not a repo
  }
  const testFiles = allChanged.filter(f => isTestFile(f));

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
  writeState(ticketId, state);
  successOut({ ok: true, phase: 'red', cycle: state.currentCycle, testFiles, testExitCode: exitCode });
}

function cmdRecordGreen(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  const cmd = parseCmd(args);
  if (!cmd) errorExit('Missing --cmd argument.');

  const state = readState(ticketId);
  if (!state) errorExit('No TDD phase state found. Run "init" first.');

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
  writeState(ticketId, state);
  successOut({ ok: true, phase: 'green', cycle: state.currentCycle, testExitCode: exitCode });
}

function cmdRecordRefactor(ticketId, args) {
  if (!ticketId) errorExit('Missing ticket ID.');
  const cmd = parseCmd(args);
  if (!cmd) errorExit('Missing --cmd argument.');

  const state = readState(ticketId);
  if (!state) errorExit('No TDD phase state found. Run "init" first.');

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
  writeState(ticketId, state);
  successOut({ ok: true, phase: 'refactor', cycle: state.currentCycle, testExitCode: exitCode });
}

function cmdTransition(ticketId, targetPhase) {
  if (!ticketId) errorExit('Missing ticket ID.');
  if (!targetPhase) errorExit('Missing target phase.');

  const state = readState(ticketId);
  if (!state) errorExit('No TDD phase state found. Run "init" first.');

  // Validate transition
  if (!tddCanTransition(state.currentPhase, targetPhase)) {
    errorExit(`Invalid transition: ${state.currentPhase} -> ${targetPhase}. ` +
      `Valid transitions: red->green, green->refactor, refactor->red.`);
  }

  // Validate evidence exists for current phase
  const currentCycleRecord = state.cycles.find(c => c.cycle === state.currentCycle);
  if (!currentCycleRecord || !currentCycleRecord[state.currentPhase]) {
    errorExit(`No evidence recorded for ${state.currentPhase} phase. ` +
      `Run "record-${state.currentPhase}" first.`);
  }

  // Update phase
  state.currentPhase = targetPhase;

  // If transitioning refactor -> red, increment cycle
  if (targetPhase === 'red') {
    state.currentCycle += 1;
  }

  writeState(ticketId, state);
  successOut({ phase: state.currentPhase, cycle: state.currentCycle });
}

// ─── Main ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const subcommand = args[0];
const ticketId = args[1];

if (GATED_SUBCOMMANDS.includes(subcommand) && process.env.WORK_TDD_TOKEN_SKIP !== '1') {
  verifyToken();
}

switch (subcommand) {
  case 'init':
    cmdInit(ticketId);
    break;
  case 'current':
    cmdCurrent(ticketId);
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
    cmdTransition(ticketId, args[2]);
    break;
  default:
    errorExit(`Unknown subcommand: ${subcommand}. ` +
      'Valid: init, current, record-red, record-green, record-refactor, transition');
}
