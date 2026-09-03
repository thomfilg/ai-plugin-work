/**
 * plan-generator.js
 *
 * Thin orchestrator for plan generation: builds shared context, initializes
 * the session guard, wires up a TDD-augmenting `add()` wrapper, then iterates
 * the STEP_PIPELINE. All per-step logic lives in workflows/work/steps/*.js.
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { STEP_PIPELINE } = require('../steps');
const { worktreeDirFrom } = require(path.join(__dirname, '..', '..', 'lib', 'resolve-base-dirs'));
const { isOutcomeMode } = require(path.join(__dirname, '..', '..', 'lib', 'tdd-mode'));

/**
 * @param {string|null} ticket
 * @param {string|null} description
 * @param {object|null} s - inspected state
 * @param {boolean} rework
 * @param {object|null} callerProviderCfg
 * @param {string|null} suffix
 * @param {object} deps - { tp, TDD_PROTOCOL, TDD_GATED_STEPS, STEPS,
 *   parseTasks, buildTaskPrompt, fileExists, run,
 *   WORKTREES_BASE, TASKS_BASE, MAIN_WORKTREE_FOLDER }
 * @returns {object} plan result
 */
/** Best-effort session-guard init; never blocks planning. */
function initSessionGuard(ticket, safeBase) {
  if (!ticket || process.env.SESSION_GUARD_ENABLED === '0') return;
  try {
    const guardPath = path.join(__dirname, '..', '..', 'lib', 'hooks', 'session-guard.js');
    execFileSync(process.execPath, [guardPath, 'init', safeBase, '/work'], {
      stdio: 'pipe',
      timeout: 5000,
    });
  } catch {
    /* fail-open */
  }
}

/** Comma-separated doc paths from an env var, rendered as a prompt suffix. */
function docsPromptFor(envVar) {
  const docs = process.env[envVar] || '';
  if (!docs.trim()) return '';
  const paths = docs
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  return `\n\nRead these docs before starting (from ${envVar}):\n${paths.map((p) => `- ${p}`).join('\n')}`;
}

/** Any pre-planning.md files under the tasks dir; [] when absent or racing. */
function findPrePlanningFiles(tasksDir, deps) {
  if (!deps.fileExists(tasksDir)) return [];
  try {
    const found = deps.run(`find "${tasksDir}" -name "pre-planning.md" -type f 2>/dev/null`);
    return found ? found.split('\n').filter(Boolean) : [];
  } catch {
    return []; /* race */
  }
}

/** The "Planning documents" block listing brief/spec/tasks + pre-planning. */
function buildPlanningContext(tasksDir, deps) {
  const { fileExists } = deps;
  const entry = (label, p) =>
    fileExists(p)
      ? `- ${label}: ${p}`
      : `- ${label} (if present after ${label.toLowerCase()} step): ${p}`;
  const planningDocs = [
    entry('Brief', path.join(tasksDir, 'brief.md')),
    entry('Spec', path.join(tasksDir, 'spec.md')),
    entry('Tasks', path.join(tasksDir, 'tasks.md')),
    ...findPrePlanningFiles(tasksDir, deps).map((f) => `- Pre-planning: ${f}`),
  ];
  return `\n\nPlanning documents — read these if they exist for requirements, test scenarios, reusable components:\n${planningDocs.join('\n')}`;
}

/**
 * The TDD-augmenting `add()` the step pipeline calls: appends a plan entry and,
 * for TDD-gated steps carrying an agentPrompt, resolves the TDD protocol into it.
 */
function makeAdd(plan, safeName, deps) {
  const { TDD_GATED_STEPS, TDD_PROTOCOL } = deps;
  return function add(stepName, action, command, reason, extra = {}) {
    // OUTCOME MODE (the WORK_TDD_MODE default) has no phases to choreograph:
    // appending the RED/GREEN protocol would tell the agent to drive
    // tdd-phase-state.js and promise hook-enforced file restrictions that the
    // enforce hooks no longer apply — directly contradicting the outcome
    // dispatch prompt it is appended to.
    if (
      !isOutcomeMode() &&
      TDD_GATED_STEPS.includes(stepName) &&
      extra.agentPrompt &&
      (action === 'RUN' || action === 'DEFER')
    ) {
      const tddStatePath = path.join(__dirname, '..', '..', 'work-implement', 'tdd-phase-state.js');
      const resolvedProtocol = TDD_PROTOCOL.replace(/<TDD_STATE_PATH>/g, tddStatePath).replace(
        /<TICKET_ID>/g,
        safeName
      );
      extra.agentPrompt = `${extra.agentPrompt}\n\n${resolvedProtocol}`;
    }
    plan.push({ step: stepName, action, ...(command ? { command } : {}), reason, ...extra });
  };
}

/**
 * The ticket-derived names and directories a plan is built around.
 *
 * State wins when it carries them (`s.worktreeDir` / `s.tasksDir`); otherwise
 * they come from the configured bases via worktreeDirFrom — never from an
 * inline `<worktrees>/<repo>-<ticket>` join.
 */
function resolvePlanPaths(ticket, s, callerProviderCfg, suffix, deps) {
  const { tp, WORKTREES_BASE, TASKS_BASE, MAIN_WORKTREE_FOLDER } = deps;
  const t = ticket || '{TICKET}';
  const safeBase = ticket ? tp.sanitizeTicketIdForPath(t, callerProviderCfg) : t;
  const safeName = suffix ? safeBase + '/' + suffix : safeBase;
  return {
    t,
    safeBase,
    safeName,
    worktreeDir: s?.worktreeDir || worktreeDirFrom(WORKTREES_BASE, MAIN_WORKTREE_FOLDER, safeBase),
    tasksDir: s?.tasksDir || `${TASKS_BASE}/${safeName}`,
  };
}

/** Wrap the plan array in the result envelope, adding suffix fields when present. */
function buildPlanResult(ticket, description, mode, plan, suffix) {
  const planResult = { ticket: ticket || `TBD ("${description}")`, mode, plan };
  if (suffix) {
    planResult.suffix = suffix;
    planResult.fullTicket = planResult.ticket + '/' + suffix;
  }
  return planResult;
}

function generatePlan(ticket, description, s, rework, callerProviderCfg, suffix, deps) {
  const { tp, STEPS, parseTasks, buildTaskPrompt, fileExists } = deps;

  const plan = [];
  const mode = rework ? 'rework' : 'resume';
  const { t, safeBase, safeName, worktreeDir, tasksDir } = resolvePlanPaths(
    ticket,
    s,
    callerProviderCfg,
    suffix,
    deps
  );

  initSessionGuard(ticket, safeBase);

  const add = makeAdd(plan, safeName, deps);

  // Shared context for step modules
  const ctx = {
    ticket,
    description,
    t,
    rework,
    suffix,
    safeName,
    safeBase,
    worktreeDir,
    tasksDir,
    plan,
    STEPS,
    tp,
    providerConfig: tp.getProviderConfig({ skipPrompt: true }),
    planningContext: buildPlanningContext(tasksDir, deps),
    getDocsPrompt: docsPromptFor,
    fileExists,
    path,
    execFileSync,
    parseTasks,
    buildTaskPrompt,
    sessionGuardPath: path.join(__dirname, '..', '..', 'lib', 'hooks', 'session-guard.js'),
    workStatePath: path.join(__dirname, '..', 'work-state.js'),
  };

  // Execute step pipeline — each handler may call add() and/or mutate ctx/plan.
  // GH-215: briefGateStep sits between briefStep and specStep in STEP_PIPELINE,
  // emitting a `brief_gate` plan entry that gates the brief → spec transition on
  // unresolved cross-ticket / architectural open questions in brief.md.
  for (const stepHandler of STEP_PIPELINE) {
    stepHandler(add, s, ctx);
  }

  // Safety net: reject any plan containing SKIP actions (GH-245).
  // All step modules (including spec-gate.js) now emit DEFER instead of SKIP.
  validatePlan(plan);

  return buildPlanResult(ticket, description, mode, plan, suffix);
}

/**
 * Validate that no plan entry uses the deprecated SKIP action.
 * Throws if any entry has action === 'SKIP'.
 *
 * @param {Array<{step: string, action: string}>} plan
 */
function validatePlan(plan) {
  for (const entry of plan) {
    if (entry.action === 'SKIP') {
      throw new Error(
        `Plan validation failed: step "${entry.step}" has forbidden action "SKIP". ` +
          `All steps must use RUN or DEFER.`
      );
    }
  }
}

module.exports = { generatePlan, validatePlan };
