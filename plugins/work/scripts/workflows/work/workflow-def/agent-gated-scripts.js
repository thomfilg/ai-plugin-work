'use strict';

/**
 * workflow-def/agent-gated-scripts.js — agent-gated writer scripts for the
 * /work workflow (extracted from workflow-definition.js).
 *
 * Consumed by enforce-step-workflow.js Rule 5. Maps script basename to
 * { agents, step }. When a Bash command invokes one of these scripts, the
 * hook verifies the caller is an authorized agent and that the correct
 * workflow step is active.
 */

const DEVELOPER_AGENTS = [
  'developer-nodejs-tdd',
  'developer-react-senior',
  'developer-react-ui-architect',
  'developer-devops',
];

// Table rows: [scriptBasename, agents, stepKey, companionScripts?]
// The `*-next.js` runners are self-paced loops that internally spawn their
// `*-phase-state.js` recorder via spawnSync. That inner call bypasses the
// PreToolUse hook, so each runner declares its recorder as a companion:
// the hook mints a write token for both scripts when an agent invokes the
// runner, allowing the inner recorder to consume its own token without a
// second hook trip.
//
// ci-next.js / ci-phase-state.js intentionally NOT agent-gated.
// The ci step is bookkeeping/polling (wait → triage → fix → rerun); the
// gated agents only existed so the main session could dispatch work, and
// forcing a developer-agent round-trip just to advance phase state was
// pure overhead with no safety benefit. Callable directly from the
// orchestrator/main session.
const SCRIPT_GATES = [
  ['write-qa-report.js', ['qa-feature-tester', 'qa-api-tester'], 'check'],
  ['write-tests-report.js', ['quality-checker'], 'check'],
  ['write-code-review.js', ['code-checker'], 'check'],
  ['write-completion-report.js', ['completion-checker'], 'check'],
  ['tdd-phase-state.js', DEVELOPER_AGENTS, 'implement'],
  // task-next.js — self-paced TDD runner (see companion note above).
  ['task-next.js', DEVELOPER_AGENTS, 'implement', ['tdd-phase-state.js']],
  // Self-paced brief runner: brief-next.js spawns brief-phase-state.js
  // internally to record/transition phase evidence during the `brief` step.
  ['brief-next.js', ['brief-writer'], 'brief', ['brief-phase-state.js']],
  ['brief-phase-state.js', ['brief-writer'], 'brief'],
  // Self-paced spec runner: same companion pattern as brief-next.js,
  // gated to the spec-writer agent during the `spec` step.
  ['spec-next.js', ['spec-writer'], 'spec', ['spec-phase-state.js']],
  ['spec-phase-state.js', ['spec-writer'], 'spec'],
  // Self-paced tasks runner: gated to the dedicated split-in-tasks agent
  // (agents/split-in-tasks.md).
  ['tasks-next.js', ['split-in-tasks'], 'tasks', ['tasks-phase-state.js']],
  ['tasks-phase-state.js', ['split-in-tasks'], 'tasks'],
  // Self-paced pr-step runner: gates the WORK orchestrator's `pr` step
  // before delegating to the /work-pr skill.
  ['pr-next.js', ['pr-generator', 'pr-post-generator'], 'pr', ['pr-phase-state.js']],
  ['pr-phase-state.js', ['pr-generator', 'pr-post-generator'], 'pr'],
  // Self-paced completion-checker runner: phases the requirement
  // verification loop during the `check` step. Both runner and
  // its inner phase-state writer are agent-gated to completion-checker.
  ['completion-next.js', ['completion-checker'], 'check', ['completion-phase-state.js']],
  ['completion-phase-state.js', ['completion-checker'], 'check'],
  // Self-paced code-checker runner: phases the code-quality audit
  // during the `check` step.
  ['code-next.js', ['code-checker'], 'check', ['code-phase-state.js']],
  ['code-phase-state.js', ['code-checker'], 'check'],
  // Self-paced qa-feature-tester runner: phases the manual QA loop
  // (env setup → smoke → feature → per-kind checks → screenshot → report).
  // Allow-list includes both qa-feature-tester and qa-api-tester so the
  // same state-state writer can serve either testing variant.
  ['qa-next.js', ['qa-feature-tester', 'qa-api-tester'], 'check', ['qa-phase-state.js']],
  ['qa-phase-state.js', ['qa-feature-tester', 'qa-api-tester'], 'check'],
  // Self-paced pr-reviewer runner: phases the PR-review loop
  // (pr context → diff audit → standards → kind-specific → post → memorize).
  ['pr-review-next.js', ['pr-reviewer'], 'check', ['pr-review-phase-state.js']],
  ['pr-review-phase-state.js', ['pr-reviewer'], 'check'],
  // Self-paced task-review runner: phases the per-task review loop
  // during the `task_review` step (between commit and check). Allow-list
  // includes code-checker as a fallback for repos without a dedicated
  // task-reviewer agent.
  [
    'task-review-next.js',
    ['task-reviewer', 'code-checker'],
    'task_review',
    ['task-review-phase-state.js'],
  ],
  ['task-review-phase-state.js', ['task-reviewer', 'code-checker'], 'task_review'],
  // Self-paced reports runner: phases the cross-step summary loop
  // during the second-to-last `reports` step (aggregates artifacts from
  // brief/spec/tasks/qa/code-review/completion + CI history).
  ['reports-next.js', ['reports-writer'], 'reports', ['reports-phase-state.js']],
  ['reports-phase-state.js', ['reports-writer'], 'reports'],
  // Self-paced cleanup runner: phases the per-ticket cleanup loop
  // (branch delete, scoped tmux kill, state archive). Defensive
  // pr_merged_check duplicates ci-step's wait_merge — cleanup never
  // runs against a non-merged PR.
  ['cleanup-next.js', ['cleanup-runner'], 'cleanup', ['cleanup-phase-state.js']],
  ['cleanup-phase-state.js', ['cleanup-runner'], 'cleanup'],
];

function buildAgentGatedScripts(STEPS) {
  const gated = {};
  for (const [script, agents, stepKey, companionScripts] of SCRIPT_GATES) {
    gated[script] = companionScripts
      ? { agents, step: STEPS[stepKey], companionScripts }
      : { agents, step: STEPS[stepKey] };
  }
  return gated;
}

module.exports = { buildAgentGatedScripts };
