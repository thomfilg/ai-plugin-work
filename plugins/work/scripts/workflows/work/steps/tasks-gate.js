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
  const fs = require('fs');
  const { parseTasks } = require('../lib/task-parser');
  const { validateAll } = require('../../lib/task-scope');
  const {
    validateConsistency: validateGherkinTaskRefs,
  } = require('../../work/lib/gherkin-task-refs');

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
    // Gate C passed — now run Gate D: gherkin↔tasks consistency.
    // Every Scenario in gherkin.feature must reference a real task via
    // @task:N and at least one @test:<path>, and every task that owns
    // scenarios must list them under `### Scenarios`. This is the
    // contract the implement-gate later relies on to refuse synthesized
    // TDD evidence — block here so the bypass can't reach implement.
    const gherkinPath = path.join(tasksDir, 'gherkin.feature');
    const tasksMdPath = path.join(tasksDir, 'tasks.md');
    if (fs.existsSync(gherkinPath) && fs.existsSync(tasksMdPath)) {
      let gherkinText = '';
      let tasksMdText = '';
      let readOk = true;
      try {
        gherkinText = fs.readFileSync(gherkinPath, 'utf8');
        tasksMdText = fs.readFileSync(tasksMdPath, 'utf8');
      } catch {
        // Files exist but unreadable (transient I/O error, permission flip,
        // mid-write). Defer the gate — re-running the orchestrator will
        // retry the read. Do NOT continue with empty strings, which would
        // make validateGherkinTaskRefs report a false-positive "invalid"
        // and trigger needless task regeneration.
        readOk = false;
      }
      if (!readOk) {
        add(
          STEPS.tasks_gate,
          'DEFER',
          null,
          'gherkin.feature and tasks.md exist but were unreadable; defer for retry'
        );
        return;
      }
      const refResult = validateGherkinTaskRefs({
        gherkinText,
        tasksMdText,
        knownTaskNums: new Set(tasks.map((t) => t.num)),
      });
      if (!refResult.valid) {
        const errorList = refResult.errors.map((e) => `  - ${e}`).join('\n');
        const promptLines = [
          `Gate D blocked tasks_gate — gherkin.feature and tasks.md are not in sync.`,
          '',
          'Every Scenario in gherkin.feature MUST:',
          '  1. Tag itself with `@task:N` pointing at an existing `## Task N` in tasks.md.',
          '  2. Tag itself with at least one `@test:<path>` whose file will exist once implemented.',
          'Every task that owns scenarios MUST list each scenario name under `### Scenarios`.',
          '',
          'Validation errors:',
          errorList,
          '',
          'Recovery:',
          `  - Edit ${gherkinPath} to add the missing tags (the artifact protector allows gherkin writes during tasks_gate).`,
          `  - Edit ${tasksMdPath} to add or correct \`### Scenarios\` bullets (verbatim names, one per line).`,
          `  - Or rewind to /work-workflow:split-in-tasks to regenerate both files together.`,
        ];
        add(STEPS.tasks_gate, 'RUN', '/work-workflow:split-in-tasks', refResult.errors.join('; '), {
          agentType: 'skill',
          agentPrompt: promptLines.join('\n'),
        });
        return;
      }
    }
    add(STEPS.tasks_gate, 'DEFER', null, `Gate C+D passed (${tasks.length} tasks)`);
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
