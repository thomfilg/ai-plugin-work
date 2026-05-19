/**
 * Step: tasks
 * Generates tasks from the technical specification.
 *
 * Decision matrix:
 *   1. hasTasks=true     → DEFER (artifact already present)
 *   2. spec.md missing   → DEFER (dependency not met)
 *   3. spec.md exists    → RUN  (generate tasks from spec)
 *
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function tasksStep(add, s, ctx) {
  const { STEPS, safeName, tasksDir, fileExists, path } = ctx;
  const specPath = path.join(tasksDir, 'spec.md');

  // The /split-in-tasks skill is the user-facing entry point. During
  // execution it MUST drive the self-paced tasks-next.js runner so the
  // requirements_extract / draft / traceability / kind_assign /
  // gherkin_link / memorize phases all gate the artifact before
  // tasks_gate runs.
  const driverHint = `\n\nDuring execution, run \`node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-tasks/tasks-next.js ${safeName}\` after each phase to validate and advance. Do NOT edit \`tasks-phase.json\` directly.`;

  if (s?.hasTasks) {
    add(STEPS.tasks, 'DEFER', null, 'tasks.md already exists');
  } else if (!fileExists(specPath)) {
    add(STEPS.tasks, 'DEFER', null, 'No spec.md — cannot generate tasks', {
      agentType: 'skill',
      agentPrompt: `/split-in-tasks ${safeName} --force${driverHint}`,
    });
  } else {
    add(STEPS.tasks, 'RUN', 'Skill(split-in-tasks)', 'Generate tasks from spec', {
      agentType: 'skill',
      agentPrompt: `/split-in-tasks ${safeName} --force${driverHint}`,
    });
  }
};
