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
const { createArtifactProtector } = require(
  path.join(__dirname, '..', '..', 'lib', 'protect-artifact-files')
);

const ALLOWED_STEPS = new Set(['tasks', 'task_review']);

/**
 * Get the ticket ID from TICKET_ID env var or derive from branch/cwd.
 * Reuses the canonical getCurrentTaskId from get-ticket-id.js.
 * @param {object} [hookData]
 * @returns {string|null}
 */
function getTicketId(hookData) {
  // Use TICKET_ID env var if set, otherwise derive from branch/cwd
  const raw =
    process.env.TICKET_ID ||
    (() => {
      try {
        const { getCurrentTaskId } = require(
          path.join(__dirname, '..', '..', 'lib', 'scripts', 'get-ticket-id')
        );
        return getCurrentTaskId() || null;
      } catch {
        return null;
      }
    })();
  if (!raw) return null;
  // Normalize (e.g., #99 → GH-99)
  let ticketId;
  try {
    ticketId = require(path.join(__dirname, '..', '..', 'lib', 'config')).safeTicketId(raw);
  } catch {
    ticketId = raw;
  }
  // Fail-open: if work state doesn't exist, return null (no ticket context → allow)
  try {
    const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
    const tasksBase = getConfig.require('TASKS_BASE');
    const statePath = path.join(tasksBase, ticketId, '.work-state.json');
    if (!fs.existsSync(statePath)) return null;
  } catch {
    return null;
  }
  return ticketId;
}

/**
 * Get the current in_progress step from .work-state.json.
 * Returns the raw step name so createArtifactProtector can match against
 * both the primary step and allowedSteps.
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
  const cmd = toolInput.command || '';

  // Additional Bash vector: resolve relative paths against cwd
  const ticketId = getTicketId(hookData);
  if (
    toolName === 'Bash' &&
    cmd.includes('tasks.md') &&
    ticketId &&
    !cmd.includes('/' + ticketId + '/')
  ) {
    try {
      const cwd = process.cwd();
      const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
      const tasksBase = getConfig.require('TASKS_BASE');
      if (cwd.startsWith(path.join(tasksBase, ticketId))) {
        // We're inside the ticket directory — relative tasks.md is ticket-scoped
        const step = getStepInProgress(ticketId);
        if (!ALLOWED_STEPS.has(step)) {
          process.stderr.write(
            'BLOCKED: Bash write to tasks.md via relative path during ' +
              (step || 'unknown') +
              ' step.\n'
          );
          process.exit(2);
        }
      }
    } catch {
      /* fail-open */
    }
  }

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
