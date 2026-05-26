/**
 * next-action-footer.js
 *
 * Shared footer renderer for self-paced *-next.js runners (brief, spec,
 * tasks, pr, ci, completion, code).
 *
 * Problem this solves (ECHO-4450 + others): runners exit 0 on three
 * distinct outcomes — PHASE ADVANCED, WAITING (validate ok=false but no
 * errors), and DONE (terminal phase). Agents read exit 0 as "task complete"
 * and stop looping, leaving the phase file stuck mid-flow.
 *
 * The footer makes the next-step intent unambiguous: re-run vs. stop.
 *
 * Usage:
 *   const { renderNextActionFooter } = require('.../lib/next-action-footer');
 *   process.stdout.write(
 *     renderNextActionFooter({ scriptName, ticket, phase, terminalPhase, advanced, blockReason })
 *   );
 */

'use strict';

/**
 * @param {object} opts
 * @param {string} opts.scriptName    basename of the runner (e.g. "brief-next.js")
 * @param {string} opts.ticket        ticket id (passed to the re-run command)
 * @param {string} opts.phase         current phase AFTER this run
 * @param {string} opts.terminalPhase terminal phase name (usually "done")
 * @param {boolean} opts.advanced     true if this invocation advanced phase
 * @param {string} opts.blockReason   non-empty when run was BLOCKED
 * @returns {string} footer to append to stdout (starts with two newlines)
 */
function renderNextActionFooter(opts) {
  const { scriptName, ticket, phase, terminalPhase, advanced, blockReason } = opts;
  const rerun = `node \$CLAUDE_PLUGIN_ROOT/scripts/workflows/${dirFor(scriptName)}/${scriptName} ${ticket}`;
  if (blockReason && !advanced) {
    return ['', '', `NEXT_ACTION: fix the block above, then re-run:`, `  ${rerun}`, ''].join('\n');
  }
  if (phase === terminalPhase) {
    return [
      '',
      '',
      `NEXT_ACTION: DONE — ${scriptName} has reached the terminal phase "${terminalPhase}".`,
      `  Do NOT re-run. Return your final report and exit.`,
      '',
    ].join('\n');
  }
  return [
    '',
    '',
    `NEXT_ACTION: perform the action above for phase "${phase}", then re-run to advance:`,
    `  ${rerun}`,
    '',
  ].join('\n');
}

/**
 * Map a runner basename to its directory under scripts/workflows/. Kept
 * here so callers don't need to hand-pass a long absolute path.
 */
function dirFor(scriptName) {
  switch (scriptName) {
    case 'brief-next.js':
      return 'work-brief';
    case 'spec-next.js':
      return 'work-spec';
    case 'tasks-next.js':
      return 'work-tasks';
    case 'pr-next.js':
      return 'work-pr-step';
    case 'ci-next.js':
      return 'work-ci';
    case 'completion-next.js':
      return 'work-completion-checker';
    case 'code-next.js':
      return 'work-code-checker';
    case 'qa-next.js':
      return 'work-qa-feature-tester';
    case 'pr-review-next.js':
      return 'work-pr-reviewer';
    case 'task-review-next.js':
      return 'work-task-review';
    case 'reports-next.js':
      return 'work-reports';
    case 'cleanup-next.js':
      return 'work-cleanup';
    default:
      return '';
  }
}

module.exports = { renderNextActionFooter, dirFor };
