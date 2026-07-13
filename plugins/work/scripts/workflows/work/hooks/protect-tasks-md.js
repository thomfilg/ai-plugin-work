#!/usr/bin/env node

/**
 * PreToolUse hook: Protect tasks.md from edits outside allowed steps.
 *
 * GH-258 Task 5: Blocks Edit/Write/MultiEdit/Bash to tasks.md when the current
 * workflow step is NOT `tasks` or `tasks_gate`. Fail-open on errors.
 *
 * Refactored to use createArtifactProtector factory (GH-258 code review).
 *
 * Allowed steps: tasks, tasks_gate, complete
 * All other steps: blocked (exit 2) — UNLESS a one-shot write token minted by
 * completion-next.js is present (see lib/tasks-md-write-token.js), which
 * permits exactly one tasks.md write for this ticket. This breaks the
 * coverage_check ↔ protect-tasks-md deadlock during the `check` step
 * (ECHO-5139/5145/5218/5320/5350/5818/5821).
 * No workflow active: allowed (exit 0, fail-open)
 */

const fs = require('fs');
const path = require('path');
const { runHook } = require(path.join(__dirname, '..', '..', 'lib', 'hookEntrypoint'));
const { createArtifactProtector } = require('../../lib/protect-artifact-files');
const { consumeTasksMdWriteToken } = require('../../lib/tasks-md-write-token');
// Vendored dual-runtime adapter: codex apply_patch payloads carry a raw patch
// (no file_path); parseApplyPatch extracts the touched paths from its headers.
const { parseApplyPatch } = require(path.join(__dirname, '..', '..', 'lib', 'runtime', 'tools'));

const ALLOWED_STEPS = new Set(['tasks', 'tasks_gate', 'complete']);

/**
 * Parsed apply_patch targets resolved against the payload cwd. Unparseable
 * targets (ok:false) are dropped — this hook fails open on them (C6:
 * advisory protector; heimdall owns the fail-closed lane).
 */
function applyPatchTargets(toolInput, hookData) {
  const cwd = (hookData && hookData.cwd) || process.cwd();
  return parseApplyPatch(toolInput?.command)
    .filter((t) => t.ok && t.path)
    .map((t) => (path.isAbsolute(t.path) ? t.path : path.resolve(cwd, t.path)));
}

/**
 * Basename-boundary matcher for `tasks.md` references inside a Bash command.
 * A raw `cmd.includes('tasks.md')` substring test also fires on UNRELATED
 * paths like `subtasks.md`, `tasks.md.bak`, or `tasks.mdx` (ECHO-5538
 * secondary bug). Require the match to be a whole basename: preceded by
 * start-of-string / path separator / shell delimiter, and not followed by a
 * word character, dot, or dash.
 */
const TASKS_MD_REF_RE = /(?:^|[/\s'"`=(<>|;&])tasks\.md(?![\w.-])/;

function bashReferencesTasksMd(cmd) {
  return TASKS_MD_REF_RE.test(cmd);
}

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
  // Keep in sync with ALLOWED_STEPS above (ECHO-5145: the header comment
  // promised `complete` but the registration only carried tasks/tasks_gate).
  artifacts: [{ basename: 'tasks.md', step: 'tasks', allowedSteps: ['tasks_gate', 'complete'] }],
  getStepInProgress,
  getTicketId,
  // Bash write-vector detection is handled by createArtifactProtector (checks basename in command strings)
});

/** Read and parse the hook payload from stdin. */
/**
 * Scan ALL whitespace-separated tokens of a Bash command for tasks.md
 * references and classify each as root-level or subfolder. A command may
 * reference both (e.g. `cat subfolder/tasks.md >> root/tasks.md`).
 * Bare tokens (no '/') are resolved against cwd to handle relative paths.
 */
function classifyBashTokenRefs(cmd, ticketId, tasksBase) {
  let hasSubfolderRef = false;
  let hasRootLevelRef = false;
  const cwd = process.cwd();
  for (const token of cmd.split(/\s+/)) {
    const cleaned = token.replace(/^[>]+/, '').replace(/['"]/g, '');
    if (!cleaned.includes('tasks.md')) continue;
    // Resolve: absolute paths stay absolute, relative paths resolve against cwd
    const resolved = cleaned.includes('/') ? cleaned : path.resolve(cwd, cleaned);
    const depth = isRootLevelTasksMd(resolved, ticketId, tasksBase);
    if (depth === false) hasSubfolderRef = true;
    if (depth === true) hasRootLevelRef = true;
  }
  return { hasSubfolderRef, hasRootLevelRef };
}

/**
 * GH-309 apply_patch leg: true when the patch references tasks.md ONLY at
 * subfolder depth (no root-level ref) — those are user-created artifacts the
 * step gate must not block.
 */
function patchTouchesOnlySubfolderTasksMd(toolInput, hookData, ticketId, tasksBase) {
  const refs = applyPatchTargets(toolInput, hookData).filter(
    (p) => path.basename(p) === 'tasks.md'
  );
  if (refs.length === 0) return false;
  const depths = refs.map((p) => isRootLevelTasksMd(p, ticketId, tasksBase));
  return depths.includes(false) && !depths.includes(true);
}

/**
 * GH-309: Early exit for subfolder tasks.md files.
 * Only the root-level <ticketId>/tasks.md is the workflow artifact that needs
 * step-gated protection. Subfolder tasks.md files (e.g. flaky-tests/tasks.md)
 * are user-created and should not be blocked. Returns true when the tool call
 * only touches subfolder tasks.md files and must be allowed unconditionally.
 */
function isSubfolderOnlyReference(toolName, toolInput, cmd, ticketId, hookData) {
  try {
    const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
    const tasksBase = getConfig.require('TASKS_BASE');

    // For Write/Edit/MultiEdit: check file_path directly
    if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
      if (isRootLevelTasksMd(toolInput.file_path, ticketId, tasksBase) === false) {
        return true; // Subfolder tasks.md — allow unconditionally
      }
    }

    // For codex apply_patch: classify every tasks.md target by depth. Allow
    // unconditionally only when subfolder refs exist and no root-level ref
    // does (same GH-309 rule as the Write/Bash vectors above/below).
    if (
      toolName === 'apply_patch' &&
      patchTouchesOnlySubfolderTasksMd(toolInput, hookData, ticketId, tasksBase)
    ) {
      return true;
    }

    // For Bash: extract all target paths from the command and check depth.
    // Only exit 0 if subfolder references exist AND no root-level reference exists.
    if (toolName === 'Bash' && bashReferencesTasksMd(cmd)) {
      const { hasSubfolderRef, hasRootLevelRef } = classifyBashTokenRefs(cmd, ticketId, tasksBase);
      if (hasSubfolderRef && !hasRootLevelRef) {
        return true; // Only subfolder tasks.md refs — allow unconditionally
      }
    }
  } catch {
    /* fail-open: if config is unavailable, fall through to protector.check */
  }
  return false;
}

/**
 * GH-309: Extract ALL relative paths referencing tasks.md from the command,
 * resolve each against cwd. This handles ../tasks.md, ./sub/tasks.md,
 * cp tasks.md ../tasks.md, etc.
 */
function classifyRelativeRefs(cmd, cwd, ticketId, tasksBase) {
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
  return { anyRoot, anySub };
}

/**
 * We're inside the ticket directory — relative tasks.md is ticket-scoped.
 * Blocks (exit 2) unless the step allows it or a one-shot completion-next.js
 * write token — the legitimate repair path for the coverage_check ↔
 * protect-tasks-md deadlock — is present.
 */
function blockRelativeWriteUnlessAllowed(ticketId) {
  const step = getStepInProgress(ticketId);
  if (ALLOWED_STEPS.has(step)) return;
  if (consumeTasksMdWriteToken(ticketId)) {
    process.exit(0);
  }
  process.stderr.write(
    'BLOCKED: Bash write to tasks.md via relative path during ' + (step || 'unknown') + ' step.\n'
  );
  process.exit(2);
}

/** Additional Bash vector: resolve relative paths against cwd. */
function handleRelativeBashVector(toolName, cmd, ticketId) {
  if (toolName !== 'Bash' || !bashReferencesTasksMd(cmd) || !ticketId) return;
  if (cmd.includes('/' + ticketId + '/')) return;
  try {
    const cwd = process.cwd();
    const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
    const tasksBase = getConfig.require('TASKS_BASE');
    if (!cwd.startsWith(path.join(tasksBase, ticketId))) return;
    // Only allow if ALL resolve to subfolder (not root).
    const { anyRoot, anySub } = classifyRelativeRefs(cmd, cwd, ticketId, tasksBase);
    if (anySub && !anyRoot) {
      process.exit(0);
    }
    blockRelativeWriteUnlessAllowed(ticketId);
  } catch {
    /* fail-open */
  }
}

/**
 * Enforce the protector verdict. Step-gated tasks.md block: honor a one-shot
 * write token minted by completion-next.js (coverage_check). The token is
 * consumed (deleted) whether or not it is valid, so it authorizes at most
 * one write.
 */
function enforceProtectorResult(result, ticketId) {
  if (!result.blocked) return;
  const isTasksMdStepBlock = result.rule === 'step' && result.file === 'tasks.md';
  if (isTasksMdStepBlock && ticketId && consumeTasksMdWriteToken(ticketId)) {
    process.exit(0);
  }
  let message = result.message;
  if (isTasksMdStepBlock) {
    message +=
      'If you are repairing the Requirement Coverage table for the completion check, ' +
      're-run completion-next.js — when coverage_check blocks it mints a one-shot ' +
      'tasks.md write token that this hook honors.\n';
  }
  process.stderr.write(message);
  process.exit(2);
}

/**
 * Whether the tool call references a file named tasks.md via any vector:
 * direct file_path, a Bash command token, or a codex apply_patch target.
 */
function referencesTasksMd(toolName, toolInput, cmd, hookData) {
  const targetBasename = toolInput.file_path ? path.basename(toolInput.file_path) : '';
  if (targetBasename === 'tasks.md') return true;
  if (toolName === 'Bash' && bashReferencesTasksMd(cmd)) return true;
  return (
    toolName === 'apply_patch' &&
    applyPatchTargets(toolInput, hookData).some((p) => path.basename(p) === 'tasks.md')
  );
}

function main(hookData) {
  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};
  const cmd = toolInput.command || '';

  const ticketId = getTicketId(hookData);
  const hasTasksMdReference = referencesTasksMd(toolName, toolInput, cmd, hookData);
  if (
    ticketId &&
    hasTasksMdReference &&
    isSubfolderOnlyReference(toolName, toolInput, cmd, ticketId, hookData)
  ) {
    process.exit(0);
  }

  handleRelativeBashVector(toolName, cmd, ticketId);

  enforceProtectorResult(protector.check(toolName, toolInput, hookData), ticketId);
  process.exit(0);
}

// runHook reads + parses stdin (malformed JSON → {}), runs the handler, and on
// an uncaught throw logs the error and exits 0 (fail-open). Intentional blocks
// exit 2 from inside main().
runHook(main, { file: __filename });
