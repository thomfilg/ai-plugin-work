/**
 * Step: tasks-gate
 *
 * Gates the `tasks → implement` transition on Gate C validation of tasks.md.
 * Mirrors `./spec-gate.js`. Validation lives in `../../lib/task-scope.js`
 * (validateAll). When the gate fails the orchestrator routes back to the
 * `tasks` step via the RETRY_EDGE registered in `../step-registry.js`.
 *
 * Decision matrix:
 *   1. `!s.hasTasks`                          → DEFER "No tasks.md present"
 *   2. tasks.md parses + validateAll passes   → DEFER with task count
 *   3. validateAll fails                      → RUN /work-workflow:split-in-tasks
 *                                                with the validation errors
 *                                                surfaced to the agent
 */

'use strict';

function tasksGateStep(add, s, ctx) {
  const { STEPS, tasksDir, path } = ctx;
  const { parseTasks } = require('../task-parser');
  const { validateAll } = require('../../lib/task-scope');

  if (!s || !s.hasTasks) {
    add(STEPS.tasks_gate, 'DEFER', null, 'No tasks.md present');
    return;
  }

  let tasks = null;
  try {
    tasks = parseTasks(tasksDir);
  } catch {
    // Parser crashed — let split-in-tasks regenerate from spec.
    add(
      STEPS.tasks_gate,
      'RUN',
      '/work-workflow:split-in-tasks',
      'tasks.md parser threw — regenerate',
      { agentType: 'skill', agentPrompt: '/work-workflow:split-in-tasks' }
    );
    return;
  }

  if (!tasks || tasks.length === 0) {
    add(
      STEPS.tasks_gate,
      'RUN',
      '/work-workflow:split-in-tasks',
      'tasks.md parsed to zero tasks — regenerate',
      { agentType: 'skill', agentPrompt: '/work-workflow:split-in-tasks' }
    );
    return;
  }

  const validation = validateAll(tasks);
  if (validation.valid) {
    add(STEPS.tasks_gate, 'DEFER', null, `Gate C passed (${tasks.length} tasks)`);
    return;
  }

  // Validation failed. Two recovery routes:
  //   (a) The agent can edit tasks.md in-place — protect-tasks-md now allows
  //       writes during tasks_gate.
  //   (b) The orchestrator can rewind to `tasks` via the RETRY_EDGE.
  // We surface BOTH in the agent prompt and let the agent (or user) decide.
  const errorList = validation.errors.map((e) => `  - ${e}`).join('\n');
  const promptLines = [
    `Gate C blocked tasks_gate — tasks.md at ${path.join(tasksDir, 'tasks.md')} is missing scope sections.`,
    '',
    'Validation errors:',
    errorList,
    '',
    'Recovery:',
    `  - Each \`## Task N\` block needs both \`### Files in scope\` (non-empty) and \`### Files explicitly out of scope\` (may be empty).`,
    `  - The artifact-protector allows tasks.md writes during this gate — edit in-place.`,
    `  - Or rewind to /work-workflow:split-in-tasks to regenerate (allowed via RETRY_EDGE).`,
  ];
  add(STEPS.tasks_gate, 'RUN', '/work-workflow:split-in-tasks', validation.errors.join('; '), {
    agentType: 'skill',
    agentPrompt: promptLines.join('\n'),
  });
}

module.exports = tasksGateStep;
module.exports.tasksGateStep = tasksGateStep;
