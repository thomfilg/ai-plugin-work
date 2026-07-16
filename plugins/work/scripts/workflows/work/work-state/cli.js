/**
 * CLI dispatch for work-state.js. Extracted from the former in-file `main()`
 * (file-size + complexity burndown). Each subcommand is now its own handler in
 * the HANDLERS table; `main()` just parses argv, looks the handler up, and runs
 * it. Per-command stdout/stderr and exit codes are byte-for-byte unchanged.
 */

'use strict';

const { loadState, initState } = require('./core');
const {
  setStepStatus,
  setCheckProgress,
  addError,
  completeWork,
  getResumeInfo,
  formatState,
} = require('./steps');
const { initSubtaskState, loadActiveSubtaskState, completeSubtask } = require('./subtasks');
const {
  getTaskCurrent,
  advanceTask,
  getTaskByIndex,
  getTaskReviewFixRounds,
  incrementTaskReviewFixRounds,
  resetTaskReviewFixRounds,
} = require('./tasks');
const { readTaskInitDescriptors } = require('./task-init');
const { initTasksMeta } = require('./task-readiness');
const { parseRecoverArgs, recoverState } = require('./recover');

// console.log(JSON.stringify(result, null, 2)) — the common success print.
function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

// Shared error gate: print to stderr and exit(1) when the result carries an error.
function exitIfError(result) {
  if (result && result.error) {
    console.error(JSON.stringify(result));
    process.exit(1);
  }
}

const HANDLERS = {
  init(args, ticketId) {
    printResult(initState(ticketId, args[2] || ''));
  },

  get(args, ticketId) {
    const result = loadState(ticketId);
    if (args[2] === '--format') {
      console.log(formatState(result));
    } else {
      printResult(result);
    }
  },

  'set-step'(args, ticketId) {
    const result = setStepStatus(ticketId, args[2], args[3]);
    exitIfError(result);
    console.log(JSON.stringify({ success: true, step: args[2], status: args[3] }));
  },

  'set-check'(args, ticketId) {
    setCheckProgress(ticketId, args[2], args[3], args[4] ? JSON.parse(args[4]) : null);
    console.log(JSON.stringify({ success: true, agent: args[2], status: args[3] }));
  },

  'add-error'(args, ticketId) {
    addError(ticketId, args[2], args[3]);
    console.log(JSON.stringify({ success: true, error: 'added' }));
  },

  complete(_args, ticketId) {
    const result = completeWork(ticketId);
    exitIfError(result);
    printResult(result);
  },

  'resume-info'(_args, ticketId) {
    printResult(getResumeInfo(ticketId));
  },

  'init-subtask'(args, ticketId) {
    printResult(initSubtaskState(ticketId, args[2] || ''));
  },

  'complete-subtask'(args, ticketId) {
    printResult(completeSubtask(ticketId, parseInt(args[2], 10)));
  },

  'active-subtask'(_args, ticketId) {
    printResult(loadActiveSubtaskState(ticketId));
  },

  async 'task-init'(args, ticketId) {
    // GH-410: optionally accept a JSON descriptor array via stdin to thread
    // per-task `kind` into tasksMeta. Legacy count-only invocation
    // (`task-init <ticket> <N>`) is preserved.
    const descriptors = await readTaskInitDescriptors(args[2]);
    if (descriptors && descriptors.error) {
      console.error(JSON.stringify(descriptors));
      process.exit(1);
    }
    const arg = descriptors ?? parseInt(args[2], 10);
    const result = initTasksMeta(ticketId, arg);
    exitIfError(result);
    console.log(JSON.stringify({ success: true, tasksMeta: result.tasksMeta }));
  },

  'task-current'(_args, ticketId) {
    const result = getTaskCurrent(ticketId);
    exitIfError(result);
    printResult(result);
  },

  'task-advance'(_args, ticketId) {
    const result = advanceTask(ticketId);
    exitIfError(result);
    printResult(result);
  },

  'task-get'(args, ticketId) {
    const result = getTaskByIndex(ticketId, args[2]);
    exitIfError(result);
    printResult(result);
  },

  'task-review-fix-rounds'(_args, ticketId) {
    const result = getTaskReviewFixRounds(ticketId);
    exitIfError(result);
    printResult(result);
  },

  'task-review-fix-rounds-increment'(_args, ticketId) {
    const result = incrementTaskReviewFixRounds(ticketId);
    exitIfError(result);
    printResult(result);
  },

  'task-review-fix-rounds-reset'(_args, ticketId) {
    const result = resetTaskReviewFixRounds(ticketId);
    exitIfError(result);
    printResult(result);
  },

  // GH-753: sanctioned wedge recovery (consistency-only; operator-approved).
  recover(args, ticketId) {
    const parsed = parseRecoverArgs(args.slice(2));
    exitIfError(parsed);
    const result = recoverState(ticketId, parsed.options);
    exitIfError(result);
    printResult(result);
  },
};

// CLI handler
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const ticketId = args[1];

  if (!command) {
    console.error('Usage: node work-state.js <command> <ticket-id> [args...]');
    console.error(
      'Commands: init, get, set-step, set-check, add-error, complete, resume-info, init-subtask, complete-subtask, active-subtask, task-init, task-current, task-advance, task-get, task-review-fix-rounds, task-review-fix-rounds-increment, task-review-fix-rounds-reset, recover'
    );
    process.exit(1);
  }

  const handler = HANDLERS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }

  await handler(args, ticketId);
}

module.exports = { main };
