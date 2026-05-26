/**
 * exception-validator.js
 *
 * Validation utilities for TDD exception mode.
 * Validates exception categories, checks for new exported code,
 * and identifies checkpoint tasks.
 */

const fs = require('fs');
const path = require('path');

// ─── Constants ──────────────────────────────────────────────────────────────

const ALLOWED_CATEGORIES = Object.freeze([
  'checkpoint',
  'config-only',
  'file-move',
  'mechanical-refactor',
]);

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);

const EXPORT_PATTERNS = [
  /module\.exports\b/,
  /\bexports\.\w/,
  /export\s+default\b/,
  /export\s+function\b/,
  /export\s+async\s+function\b/,
  /export\s+const\b/,
  /export\s+let\b/,
  /export\s+var\b/,
  /export\s+class\b/,
  /export\s+type\b/,
  /export\s+interface\b/,
  /export\s+enum\b/,
  /export\s+abstract\s+class\b/,
  /export\s*\{/,
  /export\s*\*\s*from\b/,
  /export\s*=\s*\S/,
];

// ─── validateExceptionCategory ──────────────────────────────────────────────

/**
 * Validates whether a category string is an allowed exception category.
 * @param {string} category
 * @returns {{ valid: boolean, reason: string }}
 */
function validateExceptionCategory(category) {
  if (!category || typeof category !== 'string') {
    return {
      valid: false,
      reason: 'Exception category is required and must be a non-empty string.',
    };
  }
  if (!ALLOWED_CATEGORIES.includes(category)) {
    return {
      valid: false,
      reason: `Unknown exception category "${category}". Allowed: ${ALLOWED_CATEGORIES.join(', ')}.`,
    };
  }
  return { valid: true, reason: '' };
}

// ─── checkNewExportedCode ───────────────────────────────────────────────────

/**
 * Checks whether any of the given files contain new exported code.
 * Only inspects source files (.js/.jsx/.ts/.tsx). Ignores non-source
 * extensions and gracefully skips files that cannot be read.
 *
 * @param {string[]} changedFiles — file paths (absolute or relative to cwd)
 * @returns {{ hasNewExports: boolean, files: string[] }}
 */
function checkNewExportedCode(changedFiles) {
  const filesWithExports = [];

  for (const filePath of changedFiles) {
    const ext = path.extname(filePath).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext)) continue;

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const hasExport = EXPORT_PATTERNS.some((re) => re.test(content));
    if (hasExport) {
      filesWithExports.push(filePath);
    }
  }

  return {
    hasNewExports: filesWithExports.length > 0,
    files: filesWithExports,
  };
}

// ─── isCheckpointTask ───────────────────────────────────────────────────────

/**
 * Returns true if the specified task in tasks.md is a checkpoint task.
 * Returns false on any error (missing file, invalid taskNum, etc).
 *
 * @param {string} ticketId
 * @param {number} taskNum
 * @param {string} tasksBase — root directory containing ticket subdirectories
 * @returns {boolean}
 */
function isCheckpointTask(ticketId, taskNum, tasksBase) {
  try {
    const num = Number(taskNum);
    if (!Number.isInteger(num) || num < 1) return false;

    const { parseTasks } = require('../work/lib/task-parser');
    const tasksDir = path.join(tasksBase, ticketId);
    const tasks = parseTasks(tasksDir);
    if (!tasks) return false;

    const task = tasks.find((t) => t.num === num);
    return task ? task.type === 'checkpoint' : false;
  } catch {
    return false;
  }
}

module.exports = {
  ALLOWED_CATEGORIES,
  validateExceptionCategory,
  checkNewExportedCode,
  isCheckpointTask,
};
