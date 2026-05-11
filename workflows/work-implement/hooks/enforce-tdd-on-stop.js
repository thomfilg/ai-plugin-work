#!/usr/bin/env node

/**
 * SubagentStop hook: Block developer agents from stopping without TDD evidence.
 *
 * Wired into developer agent definitions (NOT hooks.json).
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

// ─── Early exit: not in implement step ───────────────────────────────────────

const ticketId = process.env.WORK_TICKET_ID;
if (!ticketId) {
  process.exit(0);
}

// ─── Resolve paths ───────────────────────────────────────────────────────────

let TASKS_BASE;
try {
  const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
  TASKS_BASE = getConfig('TASKS_BASE');
} catch {
  process.exit(0); // can't resolve config — fail-open
}

if (!TASKS_BASE) {
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
    process.exit(0);
  }

  if (!ws.tasksMeta || !Array.isArray(ws.tasksMeta.tasks)) {
    process.exit(0);
  }

  const idx = ws.tasksMeta.currentTaskIndex ?? 0;
  taskNum = Math.min(idx + 1, ws.tasksMeta.tasks.length) || undefined;
} catch {
  process.exit(0); // can't read state — fail-open
}

if (!taskNum) {
  process.exit(0);
}

// ─── Skip checkpoint tasks ──────────────────────────────────────────────────

try {
  const { resolveTaskType } = require(
    path.join(__dirname, '..', '..', 'work2', 'lib', 'resolve-task-type')
  );
  const tasksDir = path.join(TASKS_BASE, safeTicket);
  const taskType = resolveTaskType(tasksDir, taskNum);
  if (taskType === 'checkpoint') {
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
  process.exit(0); // can't check evidence — fail-open
}

if (exists && valid) {
  process.exit(0); // evidence valid — allow stop
}

// ─── Block: get next command from tdd-next.js ────────────────────────────────

let nextCmd;
try {
  const { buildInstruction } = require(path.join(__dirname, '..', '..', 'work2', 'tdd-next'));
  const instruction = buildInstruction(safeTicket, taskNum);
  nextCmd =
    instruction.whenDone ||
    `node "${path.join(__dirname, '..', '..', 'work2', 'tdd-next.js')}" ${safeTicket} --task ${taskNum}`;
} catch {
  const tddNextPath = path.join(__dirname, '..', '..', 'work2', 'tdd-next.js');
  nextCmd = `node "${tddNextPath}" ${safeTicket} --task ${taskNum}`;
}

// ─── Log to debug.md ─────────────────────────────────────────────────────────

try {
  const debugPath = path.join(TASKS_BASE, safeTicket, 'debug.md');
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const line = `\n## ${timestamp} — enforce-tdd-on-stop\n\n- **[STOP BLOCKED]** task ${taskNum}: TDD evidence ${!exists ? 'missing' : 'invalid'}\n- **Next:** \`${nextCmd}\`\n`;
  fs.appendFileSync(debugPath, line);
} catch {
  // fail-open — debug logging is best-effort
}

// ─── Block the stop ──────────────────────────────────────────────────────────

process.stderr.write(`BLOCKED: TDD evidence incomplete for task ${taskNum}.\n`);
process.stderr.write(`Run this command: ${nextCmd}\n`);
process.exit(2);
