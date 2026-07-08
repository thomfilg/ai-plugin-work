/**
 * artifact-per-task-path.js
 *
 * Check 3 of the artifact protector (see protect-artifact-files): per-task
 * path enforcement. When tasks.md exists for the ticket, .check.md reports
 * must go to tasks/<ticketId>/task${N}/ — not the ticket root.
 * Exception: during the final /check step, per-task routing is skipped
 * (reports belong at ticket root), but the path-escape guard still applies.
 */

const fs = require('fs');
const path = require('path');

/**
 * Extract the actual target file path from a Bash command string.
 * Looks for tokens containing both the given basename and a path separator.
 * Returns null if no reliable path can be determined (caller should fail-open).
 *
 * @param {string} cmd — the raw Bash command string
 * @param {string} basename — the artifact basename to search for
 * @returns {string|null}
 */
function extractBashTargetPath(cmd, basename) {
  const tokens = cmd.split(/\s+/);
  let lastMatch = null;
  for (const token of tokens) {
    // Strip shell redirects and quotes
    const cleaned = token.replace(/^[>]+/, '').replace(/['"]/g, '');
    if (cleaned.includes(basename) && cleaned.includes('/')) {
      lastMatch = cleaned;
    }
  }
  return lastMatch;
}

/**
 * Load per-task routing context when active for the ticket: TASKS_BASE,
 * sanitized ticket id, and the parsed work state with tasksMeta. Returns
 * null when per-task mode is not active.
 */
function loadPerTaskContext(ticketId) {
  const getConfigMod = require(path.join(__dirname, 'get-config'));
  const tasksBase = getConfigMod.require('TASKS_BASE');
  // Sanitize ticketId for filesystem path (e.g. GitHub #123 → GH-123)
  const configMod = require(path.join(__dirname, 'config'));
  const safeId =
    typeof configMod.safeTicketId === 'function' ? configMod.safeTicketId(ticketId) : ticketId;
  const statePath = path.join(tasksBase, safeId, '.work-state.json');
  if (!fs.existsSync(statePath)) return null;
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!state.tasksMeta || !(state.tasksMeta.totalTasks > 0)) return null;
  return { tasksBase, safeId, state };
}

/** Determine the actual file path — for Bash, extract from command string. */
function resolveActualFilePath(toolName, filePath, bn) {
  if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) return filePath;
  // apply_patch: filePath already carries the cwd-resolved patch target.
  if (toolName === 'apply_patch') return filePath;
  // If we can't extract a reliable path, fail-open (skip per-task check)
  if (toolName === 'Bash') return extractBashTargetPath(filePath, bn);
  return null;
}

/** Compute the 1-based current task number (clamped into [1, totalTasks]). */
function computeTaskNum(tasksMeta) {
  const totalTasks = tasksMeta.totalTasks;
  const rawCurrentIdx = tasksMeta.currentTaskIndex;
  const currentIdx = Number.isInteger(rawCurrentIdx) ? rawCurrentIdx : 0;
  const normalizedIdx = Math.min(Math.max(currentIdx, 0), totalTasks - 1);
  return normalizedIdx + 1;
}

function perTaskBlock(bn, message) {
  return { blocked: true, file: bn, rule: 'per-task-path', message };
}

/**
 * Per-task routing verdict for a resolved path.
 *
 * Use path.resolve to prevent bypass via relative path components
 * (e.g., ../../ticketId/file.check.md). path.relative then gives a
 * canonical relative path; we verify it doesn't escape with '..'
 * and doesn't contain path.sep (i.e., it's a direct child, not nested).
 */
function evaluatePerTaskPath(ctx) {
  const { bn, currentStep, resolvedTicketDir, actualFilePath, taskNum } = ctx;
  const resolvedFilePath = path.resolve(actualFilePath);
  const relPath = path.relative(resolvedTicketDir, resolvedFilePath);
  const isEscapingTicketDir = relPath === '..' || relPath.startsWith('..' + path.sep);
  const isWithinTicketDir = relPath !== '' && !isEscapingTicketDir && !path.isAbsolute(relPath);
  const taskFolderPath = path.join(resolvedTicketDir, 'task' + taskNum, bn);

  // Block writes that escape the ticket directory via path traversal.
  // This guard runs unconditionally — including during the 'check' step —
  // so that writes like "/<ticket>/../outside/file.check.md" are always blocked.
  if (isEscapingTicketDir) {
    const suggestedPath =
      currentStep === 'check' ? path.join(resolvedTicketDir, bn) : taskFolderPath;
    return perTaskBlock(
      bn,
      `BLOCKED: Cannot write ${bn} outside ticket directory.\n` +
        `The resolved path escapes the ticket folder. Write your report to:\n` +
        `  ${suggestedPath}\n`
    );
  }

  // Per-task routing enforcement — skip during 'check' step
  // (final /check step writes reports at ticket root, not per-task)
  if (currentStep === 'check' || !isWithinTicketDir) return null;

  if (!relPath.includes(path.sep)) {
    // File is at ticket root (no path separator) — block and suggest correct task folder
    return perTaskBlock(
      bn,
      `BLOCKED: Cannot write ${bn} at ticket root.\n` +
        `Per-task mode is active for this ticket. Write your report to the task folder instead:\n` +
        `  ${taskFolderPath}\n`
    );
  }

  // File is in a subdirectory — validate it's the correct task folder
  const expectedPath = 'task' + taskNum + path.sep + bn;
  if (relPath !== expectedPath) {
    return perTaskBlock(
      bn,
      `BLOCKED: Cannot write ${bn} to wrong task folder.\n` +
        `You are working on task ${taskNum}. Write your report to:\n` +
        `  ${taskFolderPath}\n`
    );
  }
  return null;
}

/**
 * Check 3: Per-task path enforcement — when tasks.md exists, .check.md reports
 * must go to tasks/ticketId/task${N}/ not tasks/ticketId/ root.
 */
function checkPerTaskPath(ctx) {
  if (!ctx.bn.endsWith('.check.md')) return null;
  try {
    const perTask = loadPerTaskContext(ctx.ticketId);
    if (!perTask) return null;
    const actualFilePath = resolveActualFilePath(ctx.toolName, ctx.filePath, ctx.bn);
    // Can't determine path — skip per-task enforcement (fall through)
    if (!actualFilePath) return null;
    return evaluatePerTaskPath({
      bn: ctx.bn,
      currentStep: ctx.currentStep,
      resolvedTicketDir: path.resolve(path.join(perTask.tasksBase, perTask.safeId)),
      actualFilePath,
      taskNum: computeTaskNum(perTask.state.tasksMeta),
    });
  } catch {
    // fail-open
    return null;
  }
}

module.exports = { checkPerTaskPath, extractBashTargetPath };
