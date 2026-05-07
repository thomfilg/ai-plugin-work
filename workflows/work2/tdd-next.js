#!/usr/bin/env node

/**
 * tdd-next.js — Script-driven TDD phase orchestrator for /work2.
 *
 * Instead of the developer agent manually calling tdd-phase-state.js
 * subcommands, this script inspects the current TDD state and outputs
 * a single instruction for what the developer should do next.
 *
 * Usage: node tdd-next.js <TICKET_ID> [--task N]
 *
 * Output: JSON instruction to stdout with phase, allowed files, and next action.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

// Fail-safe
if (require.main === module) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
}

const { resolvePluginPaths } = require(path.join(__dirname, 'lib', 'resolve-plugin-root'));
const { workDir, libDir } = resolvePluginPaths(__dirname);

const getConfig = require(path.join(libDir, 'get-config'));
const TASKS_BASE = getConfig('TASKS_BASE') || '';

// Path to the real tdd-phase-state.js (marketplace)
const tddStatePath = path.join(
  path.dirname(workDir), // workflows/
  'work-implement',
  'tdd-phase-state.js'
);

/**
 * Get current TDD phase state by calling tdd-phase-state.js current.
 */
function getCurrentPhase(ticketId, taskNum) {
  const args = [tddStatePath, 'current', ticketId];
  if (taskNum) args.push('--task', String(taskNum));
  try {
    const result = execFileSync(process.execPath, args, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(result);
  } catch {
    return null;
  }
}

/**
 * Check if TDD state is initialized for this ticket/task.
 */
function isInitialized(ticketId, taskNum) {
  const safeName = ticketId;
  const taskDir = taskNum ? `task${taskNum}` : '';
  const tddPath = taskDir
    ? path.join(TASKS_BASE, safeName, taskDir, 'tdd-phase.json')
    : path.join(TASKS_BASE, safeName, 'tdd-phase.json');
  return fs.existsSync(tddPath);
}

/**
 * Build the TDD instruction based on current phase.
 */
function buildInstruction(ticketId, taskNum) {
  const initialized = isInitialized(ticketId, taskNum);
  const taskFlag = taskNum ? ` --task ${taskNum}` : '';

  if (!initialized) {
    return {
      type: 'tdd_instruction',
      phase: 'init',
      action: 'Initialize TDD state',
      command: `node "${tddStatePath}" init ${ticketId}${taskFlag}`,
      rules: {
        allowedFiles: 'all',
        description: 'Run this command to initialize TDD tracking, then run tdd-next.js again.',
      },
    };
  }

  const current = getCurrentPhase(ticketId, taskNum);
  if (!current) {
    return {
      type: 'tdd_instruction',
      phase: 'unknown',
      action: 'Cannot read TDD state',
      suggestion: `Check if ${TASKS_BASE}/${ticketId}/tdd-phase.json exists`,
    };
  }

  const phase = current.currentPhase || current.phase || 'red';

  switch (phase) {
    case 'red':
      return {
        type: 'tdd_instruction',
        phase: 'red',
        action: 'Write failing tests',
        rules: {
          allowedFiles: 'Only .test.* and .spec.* files',
          blockedFiles: 'Source/production files are BLOCKED by hooks',
          description: 'Write focused failing tests (1-3) that express expected behavior.',
        },
        whenDone: {
          record: `node "${tddStatePath}" record-red ${ticketId}${taskFlag} --cmd "<your test command>"`,
          transition: `node "${tddStatePath}" transition ${ticketId} green${taskFlag}`,
        },
      };

    case 'green':
      return {
        type: 'tdd_instruction',
        phase: 'green',
        action: 'Make tests pass with minimum code',
        rules: {
          allowedFiles: 'Source files and test helpers only',
          blockedFiles: '.test.* and .spec.* files are BLOCKED by hooks',
          description: 'Write the minimum production code to make failing tests pass.',
        },
        whenDone: {
          record: `node "${tddStatePath}" record-green ${ticketId}${taskFlag} --cmd "<your test command>"`,
          transition: `node "${tddStatePath}" transition ${ticketId} refactor${taskFlag}`,
        },
      };

    case 'refactor':
      return {
        type: 'tdd_instruction',
        phase: 'refactor',
        action: 'Clean up code (both test and production)',
        rules: {
          allowedFiles: 'All files',
          description: 'Refactor for clarity and quality. Tests must still pass after.',
        },
        whenDone: {
          record: `node "${tddStatePath}" record-refactor ${ticketId}${taskFlag} --cmd "<your test command>"`,
          nextCycle: `node "${tddStatePath}" transition ${ticketId} red${taskFlag}`,
          done: 'If no more behaviors to add, the task is complete.',
        },
      };

    default:
      return {
        type: 'tdd_instruction',
        phase,
        action: `Unknown phase: ${phase}`,
        suggestion: 'Check tdd-phase.json manually',
      };
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(
      JSON.stringify({
        type: 'tdd_instruction',
        phase: 'error',
        action: 'No ticket ID provided',
        suggestion: 'Usage: node tdd-next.js <TICKET_ID> [--task N]',
      })
    );
    process.exit(0);
  }

  const ticketId = args.filter((a) => !a.startsWith('--'))[0];
  const taskIdx = args.indexOf('--task');
  const taskNum = taskIdx >= 0 ? args[taskIdx + 1] : null;

  const instruction = buildInstruction(ticketId, taskNum);
  console.log(JSON.stringify(instruction, null, 2));
}

if (require.main === module) main();

module.exports = { buildInstruction, getCurrentPhase };
