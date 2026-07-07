/**
 * enforce-messages.js
 *
 * Block-message text for the work-implement-enforce hook. The claude
 * literals are byte-identical to the historical messages.
 */

'use strict';

const path = require('path');

/**
 * Message sweep (bugs review, W1 follow-up): this hook is LIVE, so it must
 * not point agents at the OPERATOR-ONLY `exception` subcommand
 * (WORK_OPERATOR_TOKEN-gated — agents following that advice dead-end).
 * Point at the single task entrypoint + the planner Type taxonomy, and the
 * W3 BLOCKED report for tasks that genuinely cannot be test-driven.
 */
function tddNotInitializedMessage() {
  const taskNextScript = path.join(__dirname, '..', 'task-next.js');
  return (
    'TDD not initialized. Production file writes are blocked until TDD state exists.\n' +
    'Run the single task entrypoint (it initializes state and dictates the phase):\n' +
    `  node ${taskNextScript} <TICKET_ID> task<N>\n` +
    "TDD exemptions come ONLY from the planner's `### Type` line in tasks.md\n" +
    '(tests-only/docs/config/ci/mechanical-refactor/file-move/checkpoint).\n' +
    'If this task cannot be test-driven and its Type does not exempt it, STOP\n' +
    'and report `BLOCKED (planner-defect): <one-line reason>` back to the\n' +
    'orchestrator.\n'
  );
}

/**
 * Delegation block text, per runtime. Codex has no Task tool (design C1) —
 * the persona runs INLINE, and reading the persona file is the observable
 * dispatch this hook accepts (see codexDeveloperInvocation in
 * enforce-developer-detect).
 */
function delegationBlockMessage(toolName, runtime) {
  if (runtime === 'codex') {
    const architectLine =
      process.env.WORK_ARCHITECT_ENABLED === '1'
        ? `  agents/code-architect.md            // Architecture\n`
        : '';
    return (
      `/work-implement requires developer-persona execution\n\n` +
      `Direct ${toolName} blocked. [work:codex-degraded] subagents run INLINE — ` +
      `codex has no Task tool.\n\n` +
      `Read ONE developer persona file from the work plugin's agents/ dir, adopt it,\n` +
      `then re-apply this change inline (the persona read satisfies this gate):\n` +
      `  agents/developer-nodejs-tdd.md      // Backend\n` +
      `  agents/developer-react-senior.md    // React logic\n` +
      `  agents/developer-react-ui-architect.md // UI design\n` +
      `  agents/developer-devops.md          // Infrastructure\n` +
      architectLine +
      `\nOr for simple config changes, edit allowed files:\n` +
      `(.md, .json, .yml, .env, package.json, tsconfig.*, etc.)\n`
    );
  }
  const architectLine =
    process.env.WORK_ARCHITECT_ENABLED === '1'
      ? `  subagent_type: "code-architect",            // Architecture\n`
      : '';
  return (
    `/work-implement requires agent delegation\n\n` +
    `Direct ${toolName} blocked. Use a developer agent first:\n\n` +
    `Task({\n` +
    `  subagent_type: "developer-nodejs-tdd",      // Backend\n` +
    `  subagent_type: "developer-react-senior",    // React logic\n` +
    `  subagent_type: "developer-react-ui-architect", // UI design\n` +
    `  subagent_type: "developer-devops",          // Infrastructure\n` +
    architectLine +
    `  prompt: "Implement: <your task>"\n` +
    `})\n\n` +
    `Or for simple config changes, edit allowed files:\n` +
    `(.md, .json, .yml, .env, package.json, tsconfig.*, etc.)\n`
  );
}

module.exports = { tddNotInitializedMessage, delegationBlockMessage };
