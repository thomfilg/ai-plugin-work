'use strict';

/**
 * workflow-def/gate-verifiers.js — named gate verify helpers for the /work
 * workflow definition (extracted from workflow-definition.js).
 *
 * Each helper is fail-closed: we never claim verified unless we can prove it.
 * Top-level functions take the shared deps bag as their first argument;
 * `createGateVerifiers(deps)` binds them for the workflow definition.
 *
 * @typedef {Object} GateDeps
 * @property {string} TASKS_BASE - Tasks base directory
 * @property {Function} safeTicketPath - Ticket ID sanitizer
 * @property {Function} resolveGitHead - Git HEAD resolver
 * @property {string} workRoot - workflows/work directory (for lib requires)
 */

const path = require('path');
const fs = require('fs');

/** @param {GateDeps} deps */
function verifyBootstrap(deps, ticketId) {
  // Bootstrap is proven if the current branch contains the ticket ID
  try {
    let head;
    try {
      // Worktree: .git is a file containing "gitdir: <path>"
      head = deps.resolveGitHead();
    } catch {
      // Normal repo: .git is a directory
      head = fs.readFileSync(path.join('.git', 'HEAD'), 'utf-8').trim();
    }
    const ref = head.startsWith('ref: ') ? head.slice(5) : head;
    return ref.toLowerCase().includes(ticketId.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * GH-215: Helper for STEPS.brief_gate verify. Returns true iff brief.md
 * exists for `ticketId` AND openQuestions.findBlocking(parse(brief)) is
 * empty. Fail-closed on any read/parse error — we never claim verified
 * unless we can prove it.
 * @param {GateDeps} deps
 */
function verifyBriefGate(deps, ticketId) {
  try {
    const briefPath = path.join(deps.TASKS_BASE, deps.safeTicketPath(ticketId), 'brief.md');
    if (!fs.existsSync(briefPath)) return false;
    const openQuestions = require(path.join(deps.workRoot, 'lib', 'open-questions'));
    const markdown = fs.readFileSync(briefPath, 'utf-8');
    const blocking = openQuestions.findBlocking(openQuestions.parse(markdown));
    return Array.isArray(blocking) && blocking.length === 0;
  } catch {
    return false;
  }
}

/**
 * GH-253, GH-350: Helper for STEPS.spec_gate verify. Returns true iff
 * spec.md exists AND gherkin.feature exists AND (skip override is present
 * OR parseRaw() + validate() passes). Reads gherkin.feature (standalone)
 * instead of the spec.md gherkin section.
 * Fail-closed: returns false when spec.md or gherkin.feature is missing
 * or on any error.
 * GH-244: verifySpecGate tests added in workflow-definition.test.js
 * @param {GateDeps} deps
 */
function verifySpecGate(deps, ticketId) {
  try {
    const ticketDir = path.join(deps.TASKS_BASE, deps.safeTicketPath(ticketId));
    const specPath = path.join(ticketDir, 'spec.md');
    if (!fs.existsSync(specPath)) return false; // fail-closed — missing spec blocks the gate
    const gherkinPath = path.join(ticketDir, 'gherkin.feature');
    let gherkinContent;
    try {
      gherkinContent = fs.readFileSync(gherkinPath, 'utf-8');
    } catch {
      return false; // fail-closed — missing gherkin.feature blocks the gate
    }
    const parseGherkin = require(path.join(deps.workRoot, 'lib', 'parse-gherkin'));
    const skipResult = parseGherkin.hasSkipOverride(gherkinContent);
    if (skipResult.skip) return true;
    const parsed = parseGherkin.parseRaw(gherkinContent);
    const validation = parseGherkin.validate(parsed);
    return validation.valid && parsed.errors.length === 0;
  } catch {
    return false;
  }
}

/**
 * GH-259 Task 7.2: Helper to verify per-task TDD evidence when tasks.md exists.
 * Returns true if no tasks.md, or if every taskN/ dir has valid tdd-phase.json.
 * Uses validateTddEvidence from tdd-enforcement.js (single source of truth).
 * @param {GateDeps} deps
 */
function verifyPerTaskTDD(deps, ticketId) {
  try {
    const { validateTddEvidence } = require(path.join(deps.workRoot, 'lib', 'tdd-enforcement'));
    const taskParser = require(path.join(deps.workRoot, 'lib', 'task-parser'));
    const dir = path.join(deps.TASKS_BASE, deps.safeTicketPath(ticketId));
    const tasksPath = path.join(dir, 'tasks.md');
    if (!fs.existsSync(tasksPath)) return true; // single-task mode — no per-task check
    const tasks = taskParser.parseTasks(dir);
    if (!tasks || tasks.length === 0) return false; // fail-closed: unparseable tasks.md blocks gate
    const expectedTasks = tasks.filter((t) => !t.isCheckpoint);
    if (expectedTasks.length === 0) return true; // only checkpoint tasks — no TDD evidence needed
    for (const task of expectedTasks) {
      const tddPath = path.join(dir, `task${task.num}`, 'tdd-phase.json');
      if (!fs.existsSync(tddPath)) return false;
      const state = JSON.parse(fs.readFileSync(tddPath, 'utf-8'));
      const validation = validateTddEvidence(state);
      if (!validation.valid) return false;
    } // validated via shared validateTddEvidence (tdd-enforcement.js)
    return true;
  } catch {
    return false;
  }
}

/** @param {GateDeps} deps */
function createGateVerifiers(deps) {
  return {
    verifyBootstrap: (ticketId) => verifyBootstrap(deps, ticketId),
    verifyBriefGate: (ticketId) => verifyBriefGate(deps, ticketId),
    verifySpecGate: (ticketId) => verifySpecGate(deps, ticketId),
    verifyPerTaskTDD: (ticketId) => verifyPerTaskTDD(deps, ticketId),
  };
}

module.exports = { createGateVerifiers };
