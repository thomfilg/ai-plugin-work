/**
 * plan-generator.js
 *
 * Thin orchestrator for plan generation: builds shared context, initializes
 * the session guard, wires up a TDD-augmenting `add()` wrapper, then iterates
 * the STEP_PIPELINE. All per-step logic lives in workflows/work/steps/*.js.
 */

const path = require('path');
const { execFileSync } = require('child_process');
const { STEP_PIPELINE } = require('./steps');

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
function generatePlan(ticket, description, s, rework, callerProviderCfg, suffix, deps) {
  const {
    tp,
    TDD_PROTOCOL,
    TDD_GATED_STEPS,
    STEPS,
    parseTasks,
    buildTaskPrompt,
    fileExists,
    run,
    WORKTREES_BASE,
    TASKS_BASE,
    MAIN_WORKTREE_FOLDER,
  } = deps;

  const plan = [];
  const mode = rework ? 'rework' : 'resume';
  const t = ticket || '{TICKET}';
  const safeBase = ticket ? tp.sanitizeTicketIdForPath(t, callerProviderCfg) : t;
  const safeName = suffix ? safeBase + '/' + suffix : safeBase;
  const worktreeDir = s?.worktreeDir || `${WORKTREES_BASE}/${MAIN_WORKTREE_FOLDER}-${safeBase}`;
  const tasksDir = s?.tasksDir || `${TASKS_BASE}/${safeName}`;

  // Initialize session guard for workflow locking (skip when explicitly disabled)
  if (ticket && process.env.SESSION_GUARD_ENABLED !== '0') {
    try {
      const guardPath = path.join(__dirname, '..', 'lib', 'hooks', 'session-guard.js');
      execFileSync(process.execPath, [guardPath, 'init', safeBase, '/work'], {
        stdio: 'pipe',
        timeout: 5000,
      });
    } catch {
      /* fail-open */
    }
  }

  // TDD-augmenting add() wrapper
  function add(stepName, action, command, reason, extra = {}) {
    if (
      TDD_GATED_STEPS.includes(stepName) &&
      extra.agentPrompt &&
      (action === 'RUN' || action === 'DEFER')
    ) {
      const tddStatePath = path.join(__dirname, '..', 'work-implement', 'tdd-phase-state.js');
      const resolvedProtocol = TDD_PROTOCOL.replace(/<TDD_STATE_PATH>/g, tddStatePath).replace(
        /<TICKET_ID>/g,
        safeName
      );
      extra.agentPrompt = `${extra.agentPrompt}\n\n${resolvedProtocol}`;
    }
    plan.push({ step: stepName, action, ...(command ? { command } : {}), reason, ...extra });
  }

  // Docs injection helper (used by multiple step modules)
  function getDocsPrompt(envVar) {
    const docs = process.env[envVar] || '';
    if (!docs.trim()) return '';
    const paths = docs
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    return `\n\nRead these docs before starting (from ${envVar}):\n${paths.map((p) => `- ${p}`).join('\n')}`;
  }

  // Planning docs discovery
  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  const briefPath = path.join(tasksDir, 'brief.md');
  const specPath = path.join(tasksDir, 'spec.md');
  const tasksPath = path.join(tasksDir, 'tasks.md');
  let prePlanningFiles = [];
  if (fileExists(tasksDir)) {
    try {
      const found = run(`find "${tasksDir}" -name "pre-planning.md" -type f 2>/dev/null`);
      if (found) prePlanningFiles = found.split('\n').filter(Boolean);
    } catch {
      /* race */
    }
  }
  const planningDocs = [];
  if (fileExists(briefPath)) planningDocs.push(`- Brief: ${briefPath}`);
  else planningDocs.push(`- Brief (if present after brief step): ${briefPath}`);
  if (fileExists(specPath)) planningDocs.push(`- Spec: ${specPath}`);
  else planningDocs.push(`- Spec (if present after spec step): ${specPath}`);
  if (fileExists(tasksPath)) planningDocs.push(`- Tasks: ${tasksPath}`);
  else planningDocs.push(`- Tasks (if present after tasks step): ${tasksPath}`);
  prePlanningFiles.forEach((f) => planningDocs.push(`- Pre-planning: ${f}`));
  const planningContext =
    planningDocs.length > 0
      ? `\n\nPlanning documents — read these if they exist for requirements, test scenarios, reusable components:\n${planningDocs.join('\n')}`
      : '';

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
    providerConfig,
    planningContext,
    getDocsPrompt,
    fileExists,
    path,
    execFileSync,
    parseTasks,
    buildTaskPrompt,
    sessionGuardPath: path.join(__dirname, '..', 'lib', 'hooks', 'session-guard.js'),
    workStatePath: path.join(__dirname, 'work-state.js'),
  };

  // Execute step pipeline — each handler may call add() and/or mutate ctx/plan.
  // GH-215: briefGateStep sits between briefStep and specStep in STEP_PIPELINE,
  // emitting a `brief_gate` plan entry that gates the brief → spec transition on
  // unresolved cross-ticket / architectural open questions in brief.md.
  for (const stepHandler of STEP_PIPELINE) {
    stepHandler(add, s, ctx);
  }

  const planResult = { ticket: ticket || `TBD ("${description}")`, mode, plan };
  if (suffix) {
    planResult.suffix = suffix;
    planResult.fullTicket = planResult.ticket + '/' + suffix;
  }

  // Safety net: reject any plan containing SKIP actions (GH-245).
  // All step modules (including spec-gate.js) now emit DEFER instead of SKIP.
  validatePlan(plan);

  return planResult;
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
