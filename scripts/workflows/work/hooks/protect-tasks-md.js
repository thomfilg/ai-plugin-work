#!/usr/bin/env node

/**
 * PreToolUse hook: Protect tasks.md from edits outside allowed steps.
 *
 * GH-258 Task 5: Blocks Edit/Write/MultiEdit/Bash to tasks.md when the current
 * workflow step is NOT `tasks` or `task_review`. Fail-open on errors.
 *
 * Refactored to use createArtifactProtector factory (GH-258 code review).
 *
 * Allowed steps: tasks, task_review, complete
 * All other steps: blocked (exit 2)
 * No workflow active: allowed (exit 0, fail-open)
 */

const fs = require('fs');
const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));
const { createArtifactProtector } = require('../../lib/protect-artifact-files');

const ALLOWED_STEPS = new Set(['tasks', 'task_review', 'complete']);

/**
 * Check whether a file named tasks.md is the root-level workflow artifact
 * (i.e. <tasksBase>/<ticketId>/tasks.md). Returns a three-state result:
 *
 *   true  — the file IS the root-level tasks.md (should be protected)
 *   false — the file is a subfolder tasks.md at depth 2+ (should be allowed)
 *   null  — the file is outside TASKS_BASE entirely (let protector.check handle it)
 *
 * GH-309: Only root-level tasks.md should be protected. Subfolder tasks.md
 * files are user-created artifacts that agents must be free to edit.
 *
 * @param {string} filePath — absolute path to the file being written
 * @param {string} ticketId — sanitized ticket ID (e.g. 'GH-309')
 * @param {string} tasksBase — absolute path to TASKS_BASE directory
 * @returns {boolean|null} true if root-level, false if subfolder, null if outside
 */
function isRootLevelTasksMd(filePath, ticketId, tasksBase) {
  const ticketDir = path.resolve(path.join(tasksBase, ticketId));
  const resolved = path.resolve(filePath);
  const rel = path.relative(ticketDir, resolved);
  // If the relative path escapes the ticket dir, the file is not under TASKS_BASE
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  // Root-level tasks.md has rel === 'tasks.md' (no separators) — IS root level
  if (rel === 'tasks.md') return true;
  // Any deeper path whose basename is tasks.md is a subfolder tasks.md (NOT root level)
  if (path.basename(rel) === 'tasks.md') return false;
  // Not a tasks.md file at all
  return null;
}

/**
 * Get the ticket ID from TICKET_ID env var or derive from branch/cwd.
 * Reuses the canonical getCurrentTaskId from get-ticket-id.js.
 * @param {object} [hookData]
 * @returns {string|null}
 */
function getTicketId(hookData) {
  // Use TICKET_ID env var if set, otherwise derive from branch/cwd
  const raw =
    process.env.TICKET_ID ||
    (() => {
      try {
        const { getCurrentTaskId } = require(
          path.join(__dirname, '..', '..', 'lib', 'scripts', 'get-ticket-id')
        );
        return getCurrentTaskId() || null;
      } catch {
        return null;
      }
    })();
  if (!raw) return null;
  // Normalize (e.g., #99 → GH-99)
  let ticketId;
  try {
    ticketId = require(path.join(__dirname, '..', '..', 'lib', 'config')).safeTicketId(raw);
  } catch {
    ticketId = raw;
  }
  // Fail-open: if work state doesn't exist, return null (no ticket context → allow)
  try {
    const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
    const tasksBase = getConfig.require('TASKS_BASE');
    const statePath = path.join(tasksBase, ticketId, '.work-state.json');
    if (!fs.existsSync(statePath)) return null;
  } catch {
    return null;
  }
  return ticketId;
}

/**
 * Get the current in_progress step from .work-state.json.
 * Returns the raw step name so createArtifactProtector can match against
 * both the primary step and allowedSteps.
 * @param {string} ticketId
 * @returns {string|null}
 */
function getStepInProgress(ticketId) {
  try {
    const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
    const tasksBase = getConfig('TASKS_BASE');
    if (!tasksBase) return null;

    // GH-258: ticketId is already sanitized by getTicketId (via config.safeTicketId)
    const statePath = path.join(tasksBase, ticketId, '.work-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const stepStatus = state.stepStatus || {};

    for (const [step, status] of Object.entries(stepStatus)) {
      if (status === 'in_progress') {
        return step;
      }
    }
    return null;
  } catch {
    // Fail-open by design (CLAUDE.md convention): if workflow state is unreadable
    // or no step is in_progress, allow the edit rather than block legitimate work.
    return null;
  }
}

const protector = createArtifactProtector({
  artifacts: [{ basename: 'tasks.md', step: 'tasks', allowedSteps: ['task_review'] }],
  getStepInProgress,
  getTicketId,
  // Bash write-vector detection is handled by createArtifactProtector (checks basename in command strings)
});

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};
  const cmd = toolInput.command || '';

  // GH-309: Early exit for subfolder tasks.md files.
  // Only the root-level <ticketId>/tasks.md is the workflow artifact that needs
  // step-gated protection. Subfolder tasks.md files (e.g. flaky-tests/tasks.md)
  // are user-created and should not be blocked.
  const ticketId = getTicketId(hookData);
  const targetBasename = toolInput.file_path ? path.basename(toolInput.file_path) : '';
  const hasTasksMdReference =
    targetBasename === 'tasks.md' || (toolName === 'Bash' && cmd.includes('tasks.md'));
  if (ticketId && hasTasksMdReference) {
    try {
      const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
      const tasksBase = getConfig.require('TASKS_BASE');

      // For Write/Edit/MultiEdit: check file_path directly
      if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
        if (isRootLevelTasksMd(toolInput.file_path, ticketId, tasksBase) === false) {
          process.exit(0); // Subfolder tasks.md — allow unconditionally
        }
      }

      // For Bash: extract all target paths from the command and check depth.
      // We must scan ALL tokens — a command may reference both subfolder and
      // root-level tasks.md (e.g. `cat subfolder/tasks.md >> root/tasks.md`).
      // Only exit 0 if subfolder references exist AND no root-level reference exists.
      // Bare tokens (no '/') are resolved against cwd to handle relative paths.
      if (toolName === 'Bash' && cmd.includes('tasks.md')) {
        let hasSubfolderRef = false;
        let hasRootLevelRef = false;
        const cwd = process.cwd();
        const tokens = cmd.split(/\s+/);
        for (const token of tokens) {
          const cleaned = token.replace(/^[>]+/, '').replace(/['"]/g, '');
          if (!cleaned.includes('tasks.md')) continue;
          // Resolve: absolute paths stay absolute, relative paths resolve against cwd
          const resolved = cleaned.includes('/') ? cleaned : path.resolve(cwd, cleaned);
          const depth = isRootLevelTasksMd(resolved, ticketId, tasksBase);
          if (depth === false) hasSubfolderRef = true;
          if (depth === true) hasRootLevelRef = true;
        }
        if (hasSubfolderRef && !hasRootLevelRef) {
          process.exit(0); // Only subfolder tasks.md refs — allow unconditionally
        }
      }
    } catch {
      /* fail-open: if config is unavailable, fall through to protector.check */
    }
  }

  // Additional Bash vector: resolve relative paths against cwd
  if (
    toolName === 'Bash' &&
    cmd.includes('tasks.md') &&
    ticketId &&
    !cmd.includes('/' + ticketId + '/')
  ) {
    try {
      const cwd = process.cwd();
      const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
      const tasksBase = getConfig.require('TASKS_BASE');
      if (cwd.startsWith(path.join(tasksBase, ticketId))) {
        // GH-309: Extract ALL relative paths referencing tasks.md from the command,
        // resolve each against cwd. Only allow if ALL resolve to subfolder (not root).
        // This handles ../tasks.md, ./sub/tasks.md, cp tasks.md ../tasks.md, etc.
        const refPattern = /[^\s;|&]*tasks\.md/g;
        const refs = cmd.match(refPattern) || ['tasks.md'];
        let anyRoot = false;
        let anySub = false;
        for (const ref of refs) {
          const cleaned = ref.replace(/^[>]+/, '').replace(/['"]/g, '');
          const resolved = path.resolve(cwd, cleaned);
          const depth = isRootLevelTasksMd(resolved, ticketId, tasksBase);
          if (depth === true) anyRoot = true;
          if (depth === false) anySub = true;
        }
        if (anySub && !anyRoot) {
          process.exit(0);
        }
        // We're inside the ticket directory — relative tasks.md is ticket-scoped
        const step = getStepInProgress(ticketId);
        if (!ALLOWED_STEPS.has(step)) {
          process.stderr.write(
            'BLOCKED: Bash write to tasks.md via relative path during ' +
              (step || 'unknown') +
              ' step.\n'
          );
          process.exit(2);
        }
      }
    } catch {
      /* fail-open */
    }
  }

  const result = protector.check(toolName, toolInput, hookData);
  if (result.blocked) {
    process.stderr.write(result.message);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  logHookError(__filename, err);
  process.exit(0); // fail-open
});
