/**
 * task-review-gate.js — Diff computation and review orchestration for per-task reviews (GH-211)
 *
 * Provides two main functions:
 *   - computeTaskDiff:    Determine the git diff range for a task's review
 *   - executeTaskReview:  Orchestrate tests + code review and aggregate results
 *
 * Follows the gate pattern from check-gate.js (array of rules returning reasons).
 */

'use strict';

const path = require('path');
const fs = require('fs');
const config = require(path.join(__dirname, '..', 'lib', 'config'));
const { appendAction } = require(path.join(__dirname, 'work-actions'));
const { SHA_REGEX } = require(path.join(__dirname, 'git-utils'));

// ─── Constants ──────────────────────────────────────────────────────────────
const LAST_COMMIT_SHA_FILE = '.last-commit-sha';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Read a file safely, returning empty string on failure.
 * @param {string} filePath
 * @returns {string}
 */
function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Check if a SHA is an ancestor of HEAD using git merge-base --is-ancestor.
 * Uses dynamic require to allow test mocking of child_process.execFileSync.
 * @param {string} sha - The commit SHA to check
 * @returns {boolean}
 */
function isAncestorOfHead(sha) {
  try {
    require('child_process').execFileSync('git', ['merge-base', '--is-ancestor', sha, 'HEAD'], {
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

// ─── computeTaskDiff ────────────────────────────────────────────────────────

/**
 * Compute the diff range for reviewing a task's changes.
 *
 * Reads `.last-commit-sha` from tasksDir, validates it as a 40-char hex SHA
 * that is an ancestor of HEAD. Falls back to the configured base branch
 * (e.g., origin/main) when the SHA is missing, invalid, or not an ancestor.
 *
 * @param {string} tasksDir - Path to the ticket's tasks directory
 * @param {string} ticketId - Ticket identifier (for logging)
 * @returns {{ base: string, head: string, fallback?: boolean }}
 */
function computeTaskDiff(tasksDir, ticketId) {
  const shaFile = path.join(tasksDir, LAST_COMMIT_SHA_FILE);
  const rawContent = readFileSafe(shaFile).trim();

  // Validate SHA format
  if (rawContent && SHA_REGEX.test(rawContent)) {
    // Validate SHA is an ancestor of HEAD
    if (isAncestorOfHead(rawContent)) {
      return { base: rawContent, head: 'HEAD' };
    }
    process.stderr.write(
      `task-review-gate: SHA ${rawContent.slice(0, 8)}... is not an ancestor of HEAD for ${ticketId}, falling back to base branch\n`
    );
  } else if (rawContent) {
    process.stderr.write(
      `task-review-gate: Invalid SHA format in ${LAST_COMMIT_SHA_FILE} for ${ticketId}, falling back to base branch\n`
    );
  } else {
    process.stderr.write(
      `task-review-gate: No ${LAST_COMMIT_SHA_FILE} found for ${ticketId}, falling back to base branch\n`
    );
  }

  // Fallback to base branch
  const baseBranch = config.getBaseBranch();
  return { base: baseBranch, head: 'HEAD', fallback: true };
}

// ─── executeTaskReview ──────────────────────────────────────────────────────

/**
 * @typedef {Object} ReviewResult
 * @property {boolean} passed
 * @property {string} summary
 */

/**
 * @typedef {Object} ReviewDeps
 * @property {() => ReviewResult} runTestsReview - Execute tests review
 * @property {() => ReviewResult} runCodeReview  - Execute code review
 */

/**
 * Orchestrate task review by running tests review and code review,
 * then aggregating results.
 *
 * @param {string} tasksDir   - Path to the ticket's tasks directory
 * @param {string} ticketId   - Ticket identifier
 * @param {ReviewDeps} deps   - Injected review functions
 * @returns {{ passed: boolean, testsResult: ReviewResult, codeResult: ReviewResult, reasons: string[] }}
 */
function executeTaskReview(tasksDir, ticketId, deps) {
  const testsResult = deps.runTestsReview();
  const codeResult = deps.runCodeReview();

  const reasons = [];

  if (!testsResult.passed) {
    reasons.push(`Task tests review failed: ${testsResult.summary}`);
  }
  if (!codeResult.passed) {
    reasons.push(`Task code review failed: ${codeResult.summary}`);
  }

  // Write review artifacts
  const testsArtifactPath = path.join(tasksDir, 'task-review-tests.md');
  const codeArtifactPath = path.join(tasksDir, 'task-review-code.md');

  fs.mkdirSync(tasksDir, { recursive: true });

  fs.writeFileSync(
    testsArtifactPath,
    `# Task Tests Review — ${ticketId}\n\nStatus: ${testsResult.passed ? 'PASSED' : 'FAILED'}\n\n${testsResult.summary}\n`
  );
  fs.writeFileSync(
    codeArtifactPath,
    `# Task Code Review — ${ticketId}\n\nStatus: ${codeResult.passed ? 'PASSED' : 'FAILED'}\n\n${codeResult.summary}\n`
  );

  const result = {
    passed: reasons.length === 0,
    testsResult,
    codeResult,
    reasons,
  };

  // Audit trail: log task review outcome
  appendAction(ticketId, {
    step: 'task_review',
    what: result.passed
      ? 'task review passed (tests + code)'
      : `task review failed: ${reasons.join('; ')}`,
  });

  return result;
}

// ─── Public API ─────────────────────────────────────────────────────────────

module.exports = { computeTaskDiff, executeTaskReview };
