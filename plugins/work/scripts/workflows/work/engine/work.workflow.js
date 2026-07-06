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

// ─── Extracted modules (shared orchestrator wiring) ─────────────────────────
const { parseTicketInput } = require(path.join(__dirname, '..', '..', 'lib', 'ticket-provider'));
// Explicit reference to steps/ index for spec verification (plan-generator consumes these internally)
const _stepHandlers = require(path.join(__dirname, '..', 'steps', 'index'));
void _stepHandlers;
const { main: _main } = require(path.join(__dirname, 'cli'));
const { createOrchestratorContext } = require(
  path.join(__dirname, '..', 'lib', 'orchestrator-context')
);

// passPattern is the fast path (now tolerant of the bold canonical form
// `**Status:** APPROVED`); `type` lets inspect.js fall back to the shared
// parse-report-status parser for real-world prose verdicts like
// "Overall Assessment: ✅ Well-Implemented" / "### Final Status:\n[COMPLETE]"
// (echo-5219 issue 2 — the strict regexes caused a check→pr re-dispatch loop).
const REQUIRED_REPORTS = [
  { file: 'tests.check.md', passPattern: /\*{0,2}Status:\*{0,2}\s*APPROVED/i, type: 'tests' },
  {
    file: 'code-review.check.md',
    passPattern: /\*{0,2}Status:\*{0,2}\s*APPROVED/i,
    type: 'codeReview',
  },
  {
    file: 'completion.check.md',
    passPattern: /\*{0,2}Status:\*{0,2}\s*(COMPLETE|APPROVED)/i,
    type: 'completion',
  },
];

const {
  STEPS,
  STEP_TRANSITIONS,
  ALL_STEPS,
  parseTasks,
  buildTaskPrompt,
  loadWorkState,
  saveWorkState,
  inspect,
  generatePlan,
  transitionStep,
  getAvailableTransitions,
} = createOrchestratorContext({
  workDir: path.join(__dirname, '..'),
  tp,
  appendAction,
  TASKS_BASE,
  WORKTREES_BASE,
  MAIN_WORKTREE_FOLDER,
  REQUIRED_REPORTS,
});

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
