/**
 * Tasks scope envelope gate (Gate C).
 *
 * Runs at the dedicated `tasks_gate` workflow step (between `tasks` and
 * `implement`). Parses tasks.md and refuses to advance to `implement` if
 * any task is missing `### Files in scope` / `### Files explicitly out of
 * scope` sections. The envelope is the source of truth for the runtime
 * file-edit hook (Gate D) and the post-implement scope diff (Gate E).
 *
 * Placing the validation in its own step (rather than at implement entry)
 * lets us add `tasks_gate` to tasks.md's `allowedSteps` so the gate can
 * recover from a malformed tasks.md WITHOUT widening the implement-step
 * scope — which would have created a Gate D bypass (an agent during
 * implement could otherwise edit tasks.md to grant itself broader file
 * scope).
 */

'use strict';

const path = require('path');
const { parseTasks } = require(path.join('..', '..', '..', 'work', 'task-parser'));
const { validateAll } = require('../../../lib/task-scope');

function buildBlocker(tasksDir, validation) {
  const errorList = validation.errors.map((e) => `  - ${e}`).join('\n');
  return {
    type: 'work_instruction',
    action: 'blocked',
    reason: 'tasks_gate: tasks.md scope envelope is missing or malformed',
    details:
      'Gate C requires every task in tasks.md to declare:\n' +
      '  - `### Files in scope` — glob patterns / paths the task may edit (non-empty).\n' +
      '  - `### Files explicitly out of scope` — sibling-owned paths the task must NOT edit (may be empty if no siblings).\n\n' +
      'Validation errors:\n' +
      errorList,
    hint:
      'Edit tasks.md in-place (allowed during tasks_gate) so each `## Task N` block contains both sections, ' +
      'then re-run /work. The jira-task-creator agent has the template; see agents/jira-task-creator.md. ' +
      'If the agent who wrote tasks.md was the problem, the RETRY_EDGE `tasks_gate → tasks` lets the orchestrator rewind to the tasks step.',
    tasksFile: path.join(tasksDir, 'tasks.md'),
  };
}

module.exports = function registerTasksScopeGate(register) {
  register('tasks_gate', (entry, ctx) => {
    if (entry._overrideInstruction) return; // Don't stomp other gates

    const { tasksDir } = ctx;
    let tasks = null;
    try {
      tasks = parseTasks(tasksDir);
    } catch {
      return; // fail-open on parser crash
    }
    if (!tasks) return;

    const validation = validateAll(tasks);
    if (validation.valid) {
      // Pass-through: leave entry as-is so the orchestrator advances to implement.
      return;
    }

    entry._overrideInstruction = buildBlocker(tasksDir, validation);
  });
};
