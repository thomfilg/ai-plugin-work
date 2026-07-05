/**
 * instruction-file.js — persist the latest /follow-up instruction to
 * `<TASKS_BASE>/<ticket>/.follow-up-next.json`.
 *
 * GH-214 (state-file-first invocation): the orchestrator writes this file on
 * EVERY run, so callers never need to parse stdout — an agent can invoke
 * follow-up-next.js in the background (or lose the terminal output entirely)
 * and read the compact JSON instruction from disk instead. The Stop-hook
 * session guard and the /follow-up status bar read the same file.
 *
 * A 'complete' instruction removes the file so a future run doesn't surface a
 * stale completion blob. Fail-open.
 */

'use strict';

const fs = require('fs');
const path = require('path');

function persistInstruction(TASKS_BASE, ticket, instruction) {
  try {
    const instructionPath = path.join(TASKS_BASE, ticket, '.follow-up-next.json');
    if (instruction.action === 'complete') {
      if (fs.existsSync(instructionPath)) fs.unlinkSync(instructionPath);
    } else {
      fs.writeFileSync(instructionPath, JSON.stringify(instruction, null, 2));
    }
  } catch {
    /* fail-open */
  }
}

module.exports = { persistInstruction };
