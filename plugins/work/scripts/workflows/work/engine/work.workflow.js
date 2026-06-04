#!/usr/bin/env node

/**
 * work.workflow.js — thin dispatcher for the /work command.
 *
 * Per-domain logic lives in sibling modules:
 *   - inspect.js, plan-generator.js, steps/*.js
 *   - transition-step.js, cli.js
 *   - work-helpers.js, tdd-enforcement.js
 *
 * Usage: node work.workflow.js [plan|transition|transitions|graph|actions] <args>
 * Step names live in step-registry.js. Use `graph` to inspect transitions.
 */

const path = require('path');

// Fail-safe handlers only when running as CLI (not when require()'d for tests)
if (require.main === module) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
}

// Optional modules: work-actions & ticket-provider may be missing during tests
function tryRequire(modulePath, fallback) {
  try {
    return require(modulePath);
  } catch (err) {
    if (
      err &&
      err.code === 'MODULE_NOT_FOUND' &&
      new RegExp(modulePath.replace(/.*\//, '')).test(err.message)
    ) {
      return fallback;
    }
    throw err;
  }
}
const { appendAction, loadActions, analyzeActions } = tryRequire(
  path.join(__dirname, '..', 'lib', 'work-actions'),
  { appendAction: () => {}, loadActions: () => [], analyzeActions: () => ({}) }
);
const tp = tryRequire(path.join(__dirname, '..', '..', 'lib', 'ticket-provider'), null);
if (!tp) process.exit(0);

// ─── Configuration ──────────────────────────────────────────────────────────
const MAIN_WORKTREE_FOLDER = process.env.REPO_NAME || 'my-project';
const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
const WORKTREES_BASE = getConfig('WORKTREES_BASE') || '';
const TASKS_BASE =
  getConfig('TASKS_BASE') || (WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '');

function requirePaths() {
  const missing = [];
  if (!WORKTREES_BASE) missing.push('WORKTREES_BASE');
  if (!TASKS_BASE) missing.push('TASKS_BASE');
  if (missing.length) {
    console.log(
      JSON.stringify({
        error: true,
        message: `${missing.join(', ')} not set. Set in env or ensure lib/config.js is loadable.`,
      })
    );
    process.exit(1);
  }
}

// ─── Extracted modules (wrappers thread runtime deps through) ───────────────
const { STEPS, STEP_TRANSITIONS, ALL_STEPS, workflowCanTransition } = require(
  path.join(__dirname, '..', 'step-registry')
);
const { run, fileExists, readFile, listFiles, ...helpers } = require(
  path.join(__dirname, '..', 'lib', 'work-helpers')
);
const { parseTicketInput } = require(path.join(__dirname, '..', '..', 'lib', 'ticket-provider'));
const { parseTasks, buildTaskPrompt } = require(path.join(__dirname, '..', 'lib', 'task-parser'));
const { archiveStepArtifacts } = require(path.join(__dirname, '..', 'lib', 'artifact-archival'));
const { getHeadSha } = require(path.join(__dirname, '..', 'lib', 'git-utils'));
const { TDD_PROTOCOL, readTddEvidence: _readTddEvidence, validateTddEvidence } = require(
  path.join(__dirname, '..', 'lib', 'tdd-enforcement')
);
const { inspect: _inspect } = require(path.join(__dirname, 'inspect'));
const { generatePlan: _generatePlan } = require(path.join(__dirname, 'plan-generator'));
// Explicit reference to steps/ index for spec verification (plan-generator consumes these internally)
const _stepHandlers = require(path.join(__dirname, '..', 'steps', 'index'));
void _stepHandlers;
const { validateCheckGate: _validateCheckGate } = require(path.join(__dirname, '..', 'gates', 'check-gate'));
const {
  transitionStep: _transitionStep,
  getAvailableTransitions: _getAvailableTransitions,
} = require(path.join(__dirname, 'transition-step'));
const { main: _main } = require(path.join(__dirname, 'cli'));

const TDD_GATED_STEPS = [STEPS.implement];
const REQUIRED_REPORTS = [
  { file: 'tests.check.md', passPattern: /Status:\s*APPROVED/i },
  { file: 'code-review.check.md', passPattern: /Status:\s*APPROVED/i },
  { file: 'completion.check.md', passPattern: /Status:\s*(COMPLETE|APPROVED)/i },
];

// Thin wrappers: inject TASKS_BASE / STEPS / ALL_STEPS into extracted modules
function loadWorkState(ticket) {
  return helpers.loadWorkState(TASKS_BASE, ticket);
}
function saveWorkState(ticket, state) {
  return helpers.saveWorkState(TASKS_BASE, ticket, state);
}
function getCurrentStep(workState) {
  return helpers.getCurrentStep(workState, STEPS, ALL_STEPS);
}
function readTddEvidence(ticketId, stepId, taskNum) {
  return _readTddEvidence(TASKS_BASE, ticketId, stepId, taskNum);
}
function validateCheckGate(ticket) {
  return _validateCheckGate(TASKS_BASE, ticket);
}
function inspect(ticket, providerConfig, suffix) {
  return _inspect(ticket, providerConfig, suffix, {
    tp,
    run,
    fileExists,
    readFile,
    listFiles,
    loadWorkState,
    getCurrentStep,
    REQUIRED_REPORTS,
    WORKTREES_BASE,
    TASKS_BASE,
    MAIN_WORKTREE_FOLDER,
  });
}
function generatePlan(ticket, description, s, rework, callerProviderCfg, suffix) {
  return _generatePlan(ticket, description, s, rework, callerProviderCfg, suffix, {
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
  });
}
// GH-260: Lazy-init workflow definition for step-verify gate in transitions.
// Cached after first call to avoid re-creating on every transition.
let _workflowDef = null;
function getWorkflowDefinition() {
  if (!_workflowDef) {
    const createWorkflowDefinition = require(path.join(__dirname, '..', 'workflow-definition'));
    // Compute providerConfig once (avoids repeated execSync/file reads)
    const providerConfig = tp.getProviderConfig({ skipPrompt: true });
    _workflowDef = createWorkflowDefinition({
      TASKS_BASE,
      safeTicketPath: (id) => tp.sanitizeTicketIdForPath(id, providerConfig),
      resolveGitHead: () => {
        const { resolveGitHead } = require(path.join(__dirname, '..', 'lib', 'git-utils'));
        return resolveGitHead();
      },
    });
  }
  return _workflowDef;
}
function buildTransitionDeps() {
  const { workflow } = getWorkflowDefinition();
  return {
    tp,
    STEPS,
    ALL_STEPS,
    STEP_TRANSITIONS,
    workflowCanTransition,
    TDD_GATED_STEPS,
    readTddEvidence,
    validateTddEvidence,
    validateCheckGate,
    archiveStepArtifacts,
    appendAction,
    loadWorkState,
    saveWorkState,
    getCurrentStep,
    TASKS_BASE,
    // GH-260: generic step-verify gate — always uses real verify functions.
    // Tests must provide the necessary filesystem/git state for verify to pass.
    softSteps: workflow.softSteps,
    commandMap: workflow.commandMap,
    // GH-299: check-drift gate dep
    getHeadSha,
  };
}
function transitionStep(ticket, targetStep) {
  return _transitionStep(ticket, targetStep, buildTransitionDeps());
}
function getAvailableTransitions(ticket) {
  return _getAvailableTransitions(ticket, buildTransitionDeps());
}

function main() {
  _main({
    parseTicketInput,
    inspect,
    generatePlan,
    transitionStep,
    getAvailableTransitions,
    loadActions,
    analyzeActions,
    loadWorkState,
    saveWorkState,
    appendAction,
    requirePaths,
    tp,
    STEPS,
    ALL_STEPS,
    STEP_TRANSITIONS,
  });
}

if (require.main === module) main();

// Re-export for backward compatibility
module.exports = { parseTicketInput, parseTasks, buildTaskPrompt };
