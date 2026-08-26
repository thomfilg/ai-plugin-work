/**
 * workflows/work/workflow-definition.js
 *
 * Work workflow definition -- extracted from enforce-step-workflow.js
 * for auto-discovery. Follows Open/Closed Principle: add new workflows
 * by creating workflow-definition.js in their directory.
 *
 * Assembly only — the per-step verify functions, agent-gated script map,
 * and artifact rules live in workflow-def/ sibling modules.
 */

const path = require('path');
const { STEPS, ALL_STEPS: WORK_STEPS } = require(path.join(__dirname, 'step-registry'));
const { createGateVerifiers } = require(path.join(__dirname, 'workflow-def', 'gate-verifiers'));
const { createStepVerifiers } = require(path.join(__dirname, 'workflow-def', 'step-verifiers'));
const { createDeliveryVerifiers } = require(
  path.join(__dirname, 'workflow-def', 'delivery-verifiers')
);
const { buildAgentGatedScripts } = require(
  path.join(__dirname, 'workflow-def', 'agent-gated-scripts')
);
const { buildArtifactRules } = require(path.join(__dirname, 'workflow-def', 'artifact-rules'));

// ─── Declarative policy config (GH-206 Task 12) ─────────────────────────────

// Evidence requirements per step — consumed by step verify functions and
// reporters. requiredFiles are plain basenames that must exist; qaReportPattern
// matches at least one QA report filename; requiredApprovals requires files
// to exist AND match an approval pattern.
const evidenceRequirements = {
  [STEPS.spec]: {
    // GH-247: `check` can now retry back to `spec` when the 4b_gherkin_scope
    // gate finds a declared-scope mismatch — a spec.md defect, not a code
    // defect. steps/spec.js DEFERs on "spec.md already exists", so without an
    // invalidation the retry lands on a step that declines to run and the
    // remediation the gate asked for never happens. Declaring what the step
    // rewrites lets the backward transition mark it stale instead.
    refreshedFiles: ['spec.md'],
  },
  [STEPS.check]: {
    requiredFiles: ['code-review.check.md', 'tests.check.md', 'completion.check.md', 'README.md'],
    qaReportPattern: /^qa-.*\.check\.md$/,
    // The requiredFiles the check step itself (re)writes — the subset whose
    // freshness a loop-back has to invalidate. README.md is deliberately NOT
    // here: it is a bootstrap artifact `/check` never rewrites, so demanding
    // a fresh README.md would make the check gate permanently unsatisfiable.
    refreshedFiles: ['code-review.check.md', 'tests.check.md', 'completion.check.md'],
  },
  [STEPS.reports]: {
    // \*{0,2} around the label: the canonical machine-readable status line
    // is `**Status:** APPROVED` (bold), but plain `Status:` from older
    // report writers must keep matching too.
    requiredApprovals: [
      { file: 'tests.check.md', pattern: /\*{0,2}Status:\*{0,2}\s*APPROVED/i },
      { file: 'code-review.check.md', pattern: /\*{0,2}Status:\*{0,2}\s*APPROVED/i },
      { file: 'completion.check.md', pattern: /\*{0,2}Status:\*{0,2}\s*(COMPLETE|APPROVED)/i },
    ],
    qaReportPattern: /^qa-.*\.check\.md$/,
    qaApprovalPattern: /\*{0,2}Status:\*{0,2}\s*APPROVED/i,
  },
};

// Artifact patterns per step — consumed by artifact-archival.js on backward
// transitions. `complete` has no entry because complete->complete is a
// self-transition (same index) which does not trigger archival; recovery
// archival for `complete` is handled by unstick-complete.js directly.
//
// Written as unanchored bodies so `archivalPattern` can bolt on the evidence
// guard below. Archival at the ticket root uses the guarded patterns; the
// taskN/ sweep (GH-259) uses the raw bodies — no gate reads taskN/*.check.md,
// only taskN/tdd-phase.json, so nothing there is gate evidence.
const ARCHIVAL_PATTERN_BODIES = {
  [STEPS.check]: ['.*\\.check\\.md'],
  [STEPS.pr]: ['\\.pr-update-sha', '\\.post-pr-update-sha'],
};

function escapeRegExp(literal) {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unanchor(pattern) {
  return pattern.source.replace(/^\^/, '').replace(/\$$/, '');
}

/**
 * echo-6842: archival must never target a file the SAME step's evidence
 * contract requires. `check` used to archive `/^.*\.check\.md$/`, which
 * covered three of its own four requiredFiles plus every qa-*.check.md — so
 * archiving the step moved the evidence verifyCheck and validateCheckGate
 * read, and the gate reported "Missing report: tests.check.md" for files
 * sitting in runs/runN/. The guard is derived rather than hand-written so a
 * new requiredFile is excluded automatically instead of re-opening the trap.
 *
 * Freshness after a loop-back is not lost — it moved to lib/evidence-staleness.js,
 * which invalidates the reports in place instead of moving them.
 */
function archivalPattern(step, body) {
  const reqs = evidenceRequirements[step] || {};
  const evidence = (reqs.requiredFiles || []).map(escapeRegExp);
  if (reqs.qaReportPattern) evidence.push(unanchor(reqs.qaReportPattern));
  const guard = evidence.length ? `(?!(?:${evidence.join('|')})$)` : '';
  return new RegExp(`^${guard}(?:${body})$`);
}

const archivalPatterns = Object.fromEntries(
  Object.entries(ARCHIVAL_PATTERN_BODIES).map(([step, bodies]) => [
    step,
    bodies.map((body) => archivalPattern(step, body)),
  ])
);

const perTaskArchivalPatterns = Object.fromEntries(
  Object.entries(ARCHIVAL_PATTERN_BODIES).map(([step, bodies]) => [
    step,
    bodies.map((body) => new RegExp(`^(?:${body})$`)),
  ])
);

/**
 * What `archivalPatterns` just excluded, archival COPIES into runs/runN/
 * instead of moving. GH-130 wanted each loop-back's reports preserved under
 * their run number, and that is still worth having — it was only the moving
 * that broke the gate. Copying keeps the per-run history and leaves the
 * evidence where verifyCheck and validateCheckGate read it.
 */
function preservedPattern(step) {
  const reqs = evidenceRequirements[step] || {};
  const evidence = (reqs.refreshedFiles || []).map(escapeRegExp);
  const patterns = evidence.length ? [new RegExp(`^(?:${evidence.join('|')})$`)] : [];
  if (reqs.qaReportPattern) patterns.push(reqs.qaReportPattern);
  return patterns;
}

const preservedArchivalPatterns = Object.fromEntries(
  Object.keys(ARCHIVAL_PATTERN_BODIES)
    .map((step) => [step, preservedPattern(step)])
    .filter(([, patterns]) => patterns.length > 0)
);

// Tool can be a string or array -- some runtimes emit Agent instead of Task.
//
// `advisory: true` (Task/Agent `description` mappings)
// -----------------------------------------------------
// `description` is a human-facing UI label, not a command: the orchestrator
// writes whatever reads well ("Complete CHAR-8178 brief via brief-next"), and
// several step names are ordinary English words. `/^complete\b/i` therefore
// matched a *brief* dispatch and the step gate blocked it with the
// self-contradicting "Cannot run 'brief-writer' — step complete is not
// in_progress. Current step: brief (in_progress)". The same trap is one
// sentence away for "check the fixture helper", "ready the migration",
// "report on bundle size" and "cleanup dead imports".
//
// A label can suggest what a call is; it can never prove it. So these
// mappings are ADVISORY: they attribute a call to a step only while that step
// is the one in progress (where the label is corroborated by state), and they
// never block. A match on some OTHER step is treated as the coincidence it
// is — no block, and no evidence recorded against a step whose work has not
// run. Nothing is lost by that: every advisory step is covered for the
// transition gate by its own verify() entry (cleanup/ci/reports) or by
// softSteps (ready/complete). Blocking stays with machine-checkable intent —
// a Skill name, or a script path in a Bash command.
function buildCommandMap(v) {
  return [
    { step: STEPS.bootstrap, verify: v.verifyBootstrap },
    { step: STEPS.ticket, verify: v.verifyTicket },
    { step: STEPS.brief, verify: v.verifyBrief },
    {
      // GH-215: Gate between `brief` and `spec`. Verified iff brief.md exists
      // AND every blocking open question (cross-ticket / architectural scope,
      // resolved: false) has been answered.
      step: STEPS.brief_gate,
      verify: v.verifyBriefGate,
    },
    { step: STEPS.spec, verify: v.verifySpec },
    {
      // GH-253: Gate between `spec` and `tasks`. Verified iff spec.md exists
      // AND (gherkin-skip override is present OR parse() + validate() passes).
      // Fail-closed when spec.md is missing or on any read/parse error.
      step: STEPS.spec_gate,
      verify: v.verifySpecGate,
    },
    { step: STEPS.tasks, verify: v.verifyTasks }, // verify-only entry; tool-pattern mapping follows on next line
    {
      step: STEPS.tasks,
      tool: 'Skill',
      field: 'skill',
      pattern: /^(work-workflow:)?split-in-tasks$/,
    },
    { step: STEPS.tasks_gate, verify: v.verifyTasksGate },
    { step: STEPS.implement, verify: v.verifyImplement },
    { step: STEPS.commit, verify: v.verifyCommit },
    { step: STEPS.task_review, verify: v.verifyTaskReview },
    { step: STEPS.check, verify: v.verifyCheck },
    { step: STEPS.check, tool: 'Skill', field: 'skill', pattern: /^(work-workflow:)?check$/ },
    {
      step: STEPS.cleanup,
      tool: ['Task', 'Agent'],
      field: 'description',
      advisory: true, // label-only match — attributes, never blocks (see note above)
      pattern: new RegExp(`^${STEPS.cleanup}\\b`, 'i'),
    },
    { step: STEPS.cleanup, verify: v.verifyCleanup },
    { step: STEPS.pr, verify: v.verifyPr },
    { step: STEPS.follow_up, verify: v.verifyFollowUp },
    {
      step: STEPS.ready,
      tool: ['Task', 'Agent'],
      field: 'description',
      advisory: true, // label-only match — attributes, never blocks (see note above)
      pattern: new RegExp(`^${STEPS.ready}\\b`, 'i'),
    },
    {
      step: STEPS.ci,
      tool: ['Task', 'Agent'],
      field: 'description',
      advisory: true, // label-only match — attributes, never blocks (see note above)
      pattern: new RegExp(`^${STEPS.ci}\\b`, 'i'),
    },
    { step: STEPS.ci, verify: v.verifyCi },
    {
      step: STEPS.reports,
      tool: ['Task', 'Agent'],
      field: 'description',
      advisory: true, // label-only match — attributes, never blocks (see note above)
      pattern: new RegExp(`^${STEPS.reports}\\b`, 'i'),
    },
    { step: STEPS.reports, verify: v.verifyReports },
    {
      step: STEPS.complete,
      tool: ['Task', 'Agent'],
      field: 'description',
      advisory: true, // label-only match — attributes, never blocks (see note above)
      pattern: new RegExp(`^${STEPS.complete}\\b`, 'i'),
    },
    // GH-106: Removed strict verify gate for complete step. CI/PR checks are
    // already enforced at the ci and check steps. The complete step is a soft
    // step, so no verify function is needed. This prevents deadlocks when CI
    // re-runs or PR state changes transiently after reaching the terminal step.
  ];
}

/**
 * @param {Object} deps - Shared dependencies injected by enforce-step-workflow
 * @param {string} deps.TASKS_BASE - Tasks base directory
 * @param {Function} deps.safeTicketPath - Ticket ID sanitizer
 * @param {Function} deps.resolveGitHead - Git HEAD resolver
 * @returns {{ workflow: Object, artifactRules: Array }}
 */
module.exports = function createWorkflowDefinition({ TASKS_BASE, safeTicketPath, resolveGitHead }) {
  const workRoot = __dirname;
  const gateVerifiers = createGateVerifiers({
    TASKS_BASE,
    safeTicketPath,
    resolveGitHead,
    workRoot,
  });
  const stepVerifiers = createStepVerifiers({ TASKS_BASE, safeTicketPath, workRoot });
  const deliveryVerifiers = createDeliveryVerifiers({
    TASKS_BASE,
    safeTicketPath,
    workRoot,
    STEPS,
    evidenceRequirements,
    verifyPerTaskTDD: gateVerifiers.verifyPerTaskTDD,
  });

  const workflow = {
    name: 'work',
    stateFile: '.work-state.json',
    evidenceFile: '.step-evidence.json',
    isActive: (state) => state?.status === 'in_progress',
    steps: WORK_STEPS,
    archivalPatterns,
    perTaskArchivalPatterns,
    preservedArchivalPatterns,
    evidenceRequirements,
    agentGatedScripts: buildAgentGatedScripts(STEPS),
    // Soft steps allow transition without evidence -- these are optional or metadata-only steps.
    softSteps: new Set([
      STEPS.ticket, // optional/metadata step
      STEPS.ready,
      STEPS.task_review, // GH-211: advisory per-task review gate (soft — does not block)
      STEPS.reports, // operational steps -- no code changes to enforce
      STEPS.complete, // GH-106: terminal step -- all gates already passed at ci/check/reports
    ]),
    commandMap: buildCommandMap({ ...gateVerifiers, ...stepVerifiers, ...deliveryVerifiers }),
    transitionPattern: /work\.workflow\.js\s+transition\s+(\S+)\s+(\S+)/,
    exemptPatterns: [
      /work\.workflow\.js\s+(plan|transitions|graph)/,
      // task-advance dropped (GH-695) — aligned with SAFE_SUBCOMMANDS in
      // lib/hooks/policies/hook-config.js: a Rule-1/2-exempt command that
      // Rule 3b blocks is dead config.
      /work-state\.js\s+(get|resume-info|init|task-current|task-get|task-init)/,
    ],
    transitionHint: `node ${path.join(__dirname, 'work.workflow.js')} transition`,
  };

  return { workflow, artifactRules: buildArtifactRules({ STEPS, workRoot }) };
};
