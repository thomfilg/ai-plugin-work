#!/usr/bin/env node

/**
 * tdd-next.js — Read-only TDD phase helper for /work2.
 *
 * Shows the current TDD phase and provides instructions for what the
 * developer agent should do next. Does NOT execute tdd-phase-state.js
 * commands — those must be called by an authorized developer agent
 * (agent-gated for evidence integrity).
 *
 * Usage: node tdd-next.js <TICKET_ID> [--task N]
 *
 * Output: JSON with current phase, allowed files, and commands to run.
 */

const path = require('path');
const fs = require('fs');

// Fail-safe
if (require.main === module) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
}

const { resolvePluginPaths } = require(path.join(__dirname, 'lib', 'resolve-plugin-root'));
const { workDir, libDir } = resolvePluginPaths(__dirname);

const getConfig = require(path.join(libDir, 'get-config'));
const TASKS_BASE = getConfig('TASKS_BASE') || '';

// Path to the real tdd-phase-state.js (marketplace — authorized agents call this directly)
const tddStatePath = path.join(
  path.dirname(workDir), // workflows/
  'work-implement',
  'tdd-phase-state.js'
);

/**
 * Read TDD phase state from the JSON file directly (no subprocess needed).
 */
function readPhase(ticketId, taskNum) {
  const taskDir = taskNum ? `task${taskNum}` : '';
  const tddPath = taskDir
    ? path.join(TASKS_BASE, ticketId, taskDir, 'tdd-phase.json')
    : path.join(TASKS_BASE, ticketId, 'tdd-phase.json');
  try {
    return JSON.parse(fs.readFileSync(tddPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Build phase instruction based on current state.
 */
function buildInstruction(ticketId, taskNum) {
  const taskFlag = taskNum ? ` --task ${taskNum}` : '';
  const stateCmd = `node "${tddStatePath}"`;

  const state = readPhase(ticketId, taskNum);

  if (!state) {
    return {
      type: 'tdd_instruction',
      phase: 'init',
      action: 'Initialize TDD state',
      command: `${stateCmd} init ${ticketId}${taskFlag}`,
      note: 'This command must be run by the developer agent (agent-gated).',
    };
  }

  const phase = state.currentPhase || 'red';

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
        whenDone: [
          'Run your test command to confirm tests FAIL',
          `${stateCmd} record-red ${ticketId}${taskFlag} --cmd "<your test command>"`,
          `${stateCmd} transition ${ticketId} green${taskFlag}`,
        ],
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
        whenDone: [
          'Run your test command to confirm tests PASS',
          `${stateCmd} record-green ${ticketId}${taskFlag} --cmd "<your test command>"`,
          `${stateCmd} transition ${ticketId} refactor${taskFlag}`,
        ],
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
        whenDone: [
          'Run your test command to confirm tests still PASS',
          `${stateCmd} record-refactor ${ticketId}${taskFlag} --cmd "<your test command>"`,
          `If more behaviors: ${stateCmd} transition ${ticketId} red${taskFlag}`,
          'If done: task implementation is complete.',
        ],
      };

    default:
      return { type: 'tdd_instruction', phase, action: `Unknown phase: ${phase}` };
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

module.exports = { buildInstruction, readPhase };
