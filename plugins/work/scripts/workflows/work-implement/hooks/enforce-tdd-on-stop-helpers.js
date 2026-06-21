'use strict';

/**
 * Pure helpers extracted from enforce-tdd-on-stop.js.
 *
 * These functions have NO side effects beyond `appendDebugSection` (a
 * best-effort file append that never throws) and close over no module state —
 * every input is passed explicitly. They exist to keep the hook entrypoint
 * under the static-quality line budget without changing any behavior: the
 * returned strings and exit-code flow in the hook are byte-for-byte identical
 * to the previous inline versions.
 */

const fs = require('fs');
const path = require('path');

/**
 * Append a `## <timestamp> — enforce-tdd-on-stop` section to the ticket's
 * debug.md. Best-effort: never throws (shared by the auto-record success,
 * record-failed, and bypass paths).
 *
 * @param {string} tasksBase - resolved TASKS_BASE directory
 * @param {string} safeTicket - filesystem-safe ticket id
 * @param {string} body - section body (without trailing newline)
 */
function appendDebugSection(tasksBase, safeTicket, body) {
  try {
    const debugPath = path.join(tasksBase, safeTicket, 'debug.md');
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(debugPath, `\n## ${timestamp} — enforce-tdd-on-stop\n\n${body}\n`);
  } catch {
    /* best-effort */
  }
}

/**
 * Apply phase-aware test flags:
 *   RED:   run ALL tests (need full failure picture) — command unchanged
 *   GREEN/REFACTOR: fail-fast on first failure (append --bail if absent)
 *
 * @param {string} testCommand - the resolved test command
 * @param {string} currentPhase - 'red' | 'green' | 'refactor'
 * @returns {string} the phase-adjusted command
 */
function applyPhaseTestFlags(testCommand, currentPhase) {
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
  return phaseTestCommand;
}

/**
 * Stderr message shown when tests pass during the RED phase (no failing-test
 * evidence yet). The hook refuses to fabricate GREEN and blocks the stop.
 *
 * @param {string} safeTicket
 * @param {number} taskNum
 * @returns {string}
 */
function redPassedMessage(safeTicket, taskNum) {
  return [
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
  ].join('\n');
}

/**
 * Stderr message shown when a citation-kind `### Test Strategy` task reaches
 * the stop hook without valid peer-citation evidence. Blocks the stop.
 *
 * @param {string} safeTicket
 * @param {number} taskNum
 * @returns {string}
 */
function citationBlockMessage(safeTicket, taskNum) {
  return [
    '',
    `STOP BLOCKED: task ${taskNum} uses a citation-kind \`### Test Strategy\` (no`,
    'runnable command). It is satisfied by peer-citation evidence, which is not',
    'yet recorded.',
    '',
    'What to do:',
    `  Run: node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-implement/task-next.js ${safeTicket} task${taskNum}`,
    '  It will validate the peer citation and record the green evidence for you.',
    '',
  ].join('\n');
}

module.exports = {
  appendDebugSection,
  applyPhaseTestFlags,
  redPassedMessage,
  citationBlockMessage,
};
