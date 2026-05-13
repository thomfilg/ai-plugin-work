/**
 * Tasks scope envelope gate (Gate C).
 *
 * At the `implement` step entry, parses tasks.md and refuses to dispatch
 * if any task is missing `### Files in scope` / `### Files explicitly out
 * of scope` sections. The envelope is the source of truth for the runtime
 * file-edit hook (Gate D) and the post-implement scope diff (Gate E).
 *
 * Validation lives here (rather than a new `tasks_gate` workflow step) so we
 * don't have to change the step machine. Cost: it fires per-implement
 * dispatch — cheap, since it only reads tasks.md.
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
    reason: 'implement gate: tasks.md scope envelope is missing or malformed',
    details:
      'Gate C requires every task in tasks.md to declare:\n' +
      '  - `### Files in scope` — glob patterns / paths the task may edit (non-empty).\n' +
      '  - `### Files explicitly out of scope` — sibling-owned paths the task must NOT edit (may be empty if no siblings).\n\n' +
      'Validation errors:\n' +
      errorList,
    hint:
      'Re-run the `tasks` step. Update tasks.md so each `## Task N` block contains both sections, ' +
      'then re-run /work2. The jira-task-creator agent has the template; see agents/jira-task-creator.md.',
    tasksFile: path.join(tasksDir, 'tasks.md'),
  };
}

module.exports = function registerTasksScopeGate(register) {
  register('implement', (entry, ctx) => {
    if (entry._overrideInstruction) return; // Don't stomp other gates

    const { tasksDir } = ctx;
    let tasks = null;
    try {
      tasks = parseTasks(tasksDir);
    } catch {
      return; // fail-open on parser crash
    }

    // If tasks.md doesn't exist yet (very early in the workflow) skip — the
    // workflow itself blocks the implement step on missing tasks.md via a
    // different mechanism.
    if (!tasks) return;

    const validation = validateAll(tasks);
    if (validation.valid) return;

    entry._overrideInstruction = buildBlocker(tasksDir, validation);
  });
};
