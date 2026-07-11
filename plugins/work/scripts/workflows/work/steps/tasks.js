/**
 * Step: tasks
 * Generates tasks from the technical specification.
 *
 * Decision matrix:
 *   1. hasTasks=true, ledger terminal/absent → DEFER (artifact already present)
 *   2. hasTasks=true, ledger mid-flight      → RUN  (GH-696: re-dispatch
 *      split-in-tasks — tasks-next.js resumes from the recorded phase)
 *   3. spec.md missing                       → DEFER (dependency not met)
 *   4. spec.md exists                        → RUN  (generate tasks from spec)
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
  // ECHO-4453 prevention: surface the TDD-cycle-per-task rule directly in the
  // dispatch prompt so the decomposer never splits RED/GREEN/REFACTOR across
  // tasks. tasks-gate's validateTddCycle() catches violations but a clear
  // up-front rule prevents the rework.
  const tddCycleRule = `\n\nCRITICAL — each task = ONE full TDD cycle (RED + GREEN + REFACTOR) on the SAME code surface. Use nested deliverables (e.g. 1.1.1 RED, 1.1.2 GREEN, 1.1.3 REFACTOR) within a single task — never as separate tasks. The implement-gate enforces R/G/R within one task; splitting phases across tasks wedges the workflow. See skills/split-in-tasks/SKILL.md Rule 10.`;

  if (s?.hasTasks && !s.tasksPhaseMidFlight) {
    add(STEPS.tasks, 'DEFER', null, 'tasks.md already exists');
  } else if (s?.hasTasks && s.tasksPhaseMidFlight) {
    // GH-696: tasks.md exists but the inner ledger is non-terminal — the
    // ledger-blocked verifier refuses the transition, so re-dispatch the
    // writer; tasks-next.js resumes from the recorded phase (self-heals even
    // if spec.md went missing).
    const resumeHint = `\n\nRESUME (GH-696): tasks.md already exists but the inner phase ledger tasks-phase.json is at "${s.tasksPhase}" (not "done"). Run \`node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-tasks/tasks-next.js ${safeName}\` and follow its instructions — it resumes from the recorded phase; drive it until the ledger reaches "done". Do NOT edit tasks-phase.json directly.`;
    add(
      STEPS.tasks,
      'RUN',
      'Skill(split-in-tasks)',
      `tasks.md exists but tasks-phase.json is mid-flight at "${s.tasksPhase}" — resume the tasks runner`,
      {
        agentType: 'skill',
        agentPrompt: `/split-in-tasks ${safeName} --force${resumeHint}${driverHint}${tddCycleRule}`,
      }
    );
  } else if (!fileExists(specPath)) {
    add(STEPS.tasks, 'DEFER', null, 'No spec.md — cannot generate tasks', {
      agentType: 'skill',
      agentPrompt: `/split-in-tasks ${safeName} --force${driverHint}${tddCycleRule}`,
    });
  } else {
    add(STEPS.tasks, 'RUN', 'Skill(split-in-tasks)', 'Generate tasks from spec', {
      agentType: 'skill',
      agentPrompt: `/split-in-tasks ${safeName} --force${driverHint}${tddCycleRule}`,
    });
  }
};
