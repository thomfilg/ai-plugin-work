#!/usr/bin/env node

/**
 * PreToolUse hook: Protect tasks.md from edits outside allowed steps.
 *
 * GH-258 Task 5: Blocks Edit/Write/MultiEdit/Bash to tasks.md when the current
 * workflow step is NOT `tasks` or `task_review`. Fail-open on errors.
 *
 * Refactored to use createArtifactProtector factory (GH-258 code review).
 *
 * Allowed steps: tasks, task_review
 * All other steps: blocked (exit 2)
 * No workflow active: allowed (exit 0, fail-open)
 */

const fs = require('fs');
const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));
const { createArtifactProtector } = require(path.join(__dirname, '..', '..', 'lib', 'protect-artifact-files'));

/**
 * Get the ticket ID from TICKET_ID env var or derive from branch/cwd.
 * Reuses the canonical getCurrentTaskId from get-ticket-id.js.
 * @param {object} [hookData]
 * @returns {string|null}
 */
function getTicketId(hookData) {
  // Use TICKET_ID env var if set, otherwise derive from branch/cwd
  const raw = process.env.TICKET_ID || (() => {
    try {
      const { getCurrentTaskId } = require(path.join(__dirname, '..', '..', 'lib', 'scripts', 'get-ticket-id'));
      return getCurrentTaskId() || null;
    } catch { return null; }
  })();
  if (!raw) return null;
  // Normalize (e.g., #99 → GH-99)
  try {
    return require(path.join(__dirname, '..', '..', 'lib', 'config')).safeTicketId(raw);
  } catch { return raw; }
}

/**
 * Get the current in_progress step from .work-state.json.
 * @param {string} ticketId
 * @returns {string|null}
 */
function getStepInProgress(ticketId) {
  try {
    const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
    const tasksBase = getConfig('TASKS_BASE');
    if (!tasksBase) return null;

    // GH-258: ticketId is already sanitized by getTicketId (via config.safeTicketId)
    const statePath = path.join(tasksBase, ticketId, '.work-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const stepStatus = state.stepStatus || {};

    for (const [step, status] of Object.entries(stepStatus)) {
      if (status === 'in_progress') {
        return step;
      }
    }
    return null;
  } catch {
    // Fail-open by design (CLAUDE.md convention): if workflow state is unreadable
    // or no step is in_progress, allow the edit rather than block legitimate work.
    return null;
  }
}

const protector = createArtifactProtector({
  artifacts: [{ basename: 'tasks.md', step: 'tasks', allowedSteps: ['task_review'] }],
  getStepInProgress,
  getTicketId,
  // Bash write-vector detection is handled by createArtifactProtector (checks basename in command strings)
});

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};

  const result = protector.check(toolName, toolInput, hookData);
  if (result.blocked) {
    process.stderr.write(result.message);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  logHookError(__filename, err);
  process.exit(0); // fail-open
});
