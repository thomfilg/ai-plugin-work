/**
 * protect-artifact-files.js
 *
 * Reusable factory for step-gated and agent-gated file protection.
 * Blocks writes to artifact files unless:
 *   1. The owning workflow step is in_progress
 *   2. The caller is an authorized agent (if agents are specified)
 *
 * Usage:
 *   const { createArtifactProtector } = require('./lib/protect-artifact-files');
 *
 *   const protector = createArtifactProtector({
 *     artifacts: [
 *       { basename: 'brief.md', step: 'brief' },
 *       { basename: 'spec.md', step: 'spec' },
 *       { pattern: /\.check\.md$/, step: 'check', agents: ['code-checker', 'qa-feature-tester'] },
 *     ],
 *     getStepInProgress: (ticketId) => currentStep,  // returns step name or null
 *     isRunningInAgent: (transcriptPath, agents, hookData) => boolean,
 *     getTicketId: () => string|null,  // returns current ticket ID
 *   });
 *
 *   // In your PreToolUse handler:
 *   const result = protector.check(toolName, toolInput, hookData);
 *   if (result.blocked) {
 *     process.stderr.write(result.message);
 *     process.exit(2);
 *   }
 */

const path = require('path');
// Vendored dual-runtime adapter (see factories/runtime): parses the codex
// apply_patch payload (`*** Add/Update/Delete File:` headers) into targets.
const { parseApplyPatch } = require('./runtime/tools');

/** Shell write operators — redirects, tee, cp, mv, dd */
const BASH_WRITE_OPS = /(?:>{1,2}|\btee\b|\bcp\b|\bmv\b|\bdd\b.*\bof=)/;

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

/** Node.js fs write calls executed via Bash */
const NODE_FS_WRITES = /\b(?:writeFileSync|appendFileSync|writeFile|createWriteStream)\b/;

/**
 * Whole-basename reference test for Bash command strings.
 * A raw `cmd.includes(basename)` also fires on unrelated files that merely
 * CONTAIN the artifact basename as a substring — e.g. `subtasks.md`,
 * `tasks.md.bak`, `tasks.mdx` for artifact `tasks.md` (ECHO-5538 secondary
 * bug). Require the basename to be delimited: preceded by start-of-string,
 * a path separator, or a shell delimiter, and not followed by a word
 * character, dot, or dash.
 */
function bashReferencesBasename(cmd, basename) {
  const esc = basename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[/\\s'"\`=(<>|;&])${esc}(?![\\w.-])`).test(cmd);
}

/**
 * @typedef {object} ArtifactRule
 * @property {string} [basename] — exact file basename to match
 * @property {RegExp} [pattern] — regex to match against file basename
 * @property {string} step — the primary workflow step that owns this artifact
 * @property {string[]} [allowedSteps] — additional steps that may write this artifact (checked alongside `step`)
 * @property {string[]} [agents] — authorized agent names (if omitted, any agent in the step is allowed)
 */

/**
 * @typedef {object} ArtifactCheckResult
 * @property {boolean} blocked
 * @property {string} [file] — the matched filename
 * @property {string} [rule] — 'step' or 'agent'
 * @property {string} [message] — formatted block message
 */

/**
 * Match a filename against an artifact rule.
 * @param {string} basename
 * @param {ArtifactRule} rule
 * @returns {boolean}
 */
function matchesRule(basename, rule) {
  if (rule.basename) return rule.basename === basename;
  if (rule.pattern) return rule.pattern.test(basename);
  return false;
}

/**
 * Vector 2: Bash shell writes — find the first artifact rule referenced by
 * the command (whole-basename match — substring hits like `subtasks.md`
 * must not trigger the rule).
 */
function matchBashArtifact(artifacts, cmd) {
  for (const a of artifacts) {
    if (a.basename && bashReferencesBasename(cmd, a.basename)) {
      return { bn: a.basename, rule: a };
    }
    if (a.pattern) {
      // Extract potential filenames from command tokens
      const tokens = cmd.match(/[\w.-]+\.(?:md|json|txt)/g) || [];
      const match = tokens.find((t) => a.pattern.test(t));
      if (match) return { bn: match, rule: a };
    }
  }
  return null;
}

/**
 * Resolve the write target (basename + path context + matching rule) for the
 * tool call, or null when the call does not touch a protected artifact.
 */
function matchDirectWriteTarget(artifacts, toolInput) {
  // Vector 1: Direct file writes
  const filePath = toolInput?.file_path || '';
  if (!filePath) return null;
  const bn = path.basename(filePath);
  const rule = artifacts.find((a) => matchesRule(bn, a));
  return rule ? { bn, filePath, rule } : null;
}

/** Bash shell writes: >, >>, tee, cp, mv, sed -i, cat >, node -e writeFileSync */
function hasBashWriteVector(cmd) {
  return BASH_WRITE_OPS.test(cmd) || NODE_FS_WRITES.test(cmd) || /\bsed\s+-i\b/.test(cmd);
}

/**
 * Codex apply_patch vector: the Edit/Write matcher lanes alias-fire for
 * apply_patch but the payload is a raw patch (no file_path). Resolve every
 * parsed target against the payload cwd and match the FIRST artifact rule
 * hit. Unparseable targets (ok:false) fail open — advisory protector (C6).
 */
function matchApplyPatchTarget(artifacts, toolInput, hookData) {
  const cwd = (hookData && hookData.cwd) || process.cwd();
  for (const target of parseApplyPatch(toolInput?.command)) {
    if (!target.ok || !target.path) continue;
    const resolved = path.isAbsolute(target.path) ? target.path : path.resolve(cwd, target.path);
    const bn = path.basename(resolved);
    const rule = artifacts.find((a) => matchesRule(bn, a));
    if (rule) return { bn, filePath: resolved, rule };
  }
  return null;
}

function matchWriteTarget(artifacts, toolName, toolInput, hookData) {
  if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
    return matchDirectWriteTarget(artifacts, toolInput);
  }
  if (toolName === 'apply_patch') {
    return matchApplyPatchTarget(artifacts, toolInput, hookData);
  }
  if (toolName !== 'Bash') return null;
  const cmd = String(toolInput?.command || '');
  if (!hasBashWriteVector(cmd)) return null;
  const matched = matchBashArtifact(artifacts, cmd);
  // Use cmd as context for ticket ID check
  return matched ? { bn: matched.bn, filePath: cmd, rule: matched.rule } : null;
}

/** Check 1: Step must be in_progress (primary step or any allowedSteps). */
function checkStepGate(rule, currentStep, bn) {
  const stepAllowed =
    currentStep === rule.step ||
    (Array.isArray(rule.allowedSteps) && rule.allowedSteps.includes(currentStep));
  if (stepAllowed) return null;
  const stepsLabel = rule.allowedSteps ? [rule.step, ...rule.allowedSteps].join(', ') : rule.step;
  return {
    blocked: true,
    file: bn,
    rule: 'step',
    message:
      `BLOCKED: Cannot write ${bn} — none of the allowed step(s) '${stepsLabel}' are in_progress.\n` +
      `Current step: ${currentStep || '(none)'}\n` +
      `Only the ${stepsLabel} step(s) may create/modify this file.\n`,
  };
}

/** Check 2: Agent must be authorized (if agents specified). */
function checkAgentGate(rule, hookData, isRunningInAgent, bn) {
  if (!rule.agents || rule.agents.length === 0) return null;
  const transcriptPath = hookData?.transcript_path;
  if (isRunningInAgent(transcriptPath, rule.agents, hookData)) return null;
  return {
    blocked: true,
    file: bn,
    rule: 'agent',
    message:
      `BLOCKED: Cannot write ${bn} — not running in an authorized agent.\n` +
      `Allowed agents: ${rule.agents.join(', ')}\n` +
      `This file can only be created/modified by the designated agent during the ${rule.step} step.\n`,
  };
}

/**
 * Load per-task routing context when active for the ticket: TASKS_BASE,
 * sanitized ticket id, and the parsed work state with tasksMeta. Returns
 * null when per-task mode is not active.
 */
function loadPerTaskContext(ticketId) {
  const fs = require('fs');
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
 * Exception: during the final /check step, per-task routing is skipped
 * (reports belong at ticket root), but the path-escape guard still applies.
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

/**
 * For Edit/MultiEdit, read the existing file and apply the edit in memory to
 * get the resulting content the guard should evaluate.
 */
function simulateEditContent(toolInput) {
  const fs = require('fs');
  const existing = fs.readFileSync(toolInput?.file_path, 'utf-8');
  const oldStr = toolInput?.old_string || '';
  const newStr = toolInput?.new_string || '';
  if (oldStr && newStr) return existing.replace(oldStr, newStr);
  return existing; // Can't simulate edit, check existing
}

function resolveGuardContent(toolName, toolInput) {
  if (toolName === 'Write') return toolInput?.content || '';
  try {
    return simulateEditContent(toolInput);
  } catch {
    return toolInput?.new_string || ''; // File doesn't exist yet, fall back
  }
}

/** Check 4: Content guard (if specified on the rule). */
function checkContentGuard(rule, toolName, toolInput, currentStep, bn) {
  if (!rule.contentGuard || !['Write', 'Edit', 'MultiEdit'].includes(toolName)) return null;
  const guardContent = resolveGuardContent(toolName, toolInput);
  if (!guardContent) return null;
  const guardResult = rule.contentGuard(guardContent, currentStep);
  if (!guardResult.blocked) return null;
  return { blocked: true, file: bn, rule: 'content', message: guardResult.message };
}

/**
 * Create an artifact protector instance.
 *
 * @param {object} opts
 * @param {ArtifactRule[]} opts.artifacts — list of protected artifact rules
 * @param {(ticketId: string) => string|null} opts.getStepInProgress
 *   Returns the currently in_progress step name for the given ticket, or null.
 * @param {(transcriptPath: string, agents: string[], hookData?: object) => boolean} [opts.isRunningInAgent]
 *   Returns true if the current context is inside one of the specified agents.
 *   Receives hookData as third arg for hookData-based agent detection.
 *   Only needed if any artifact rule has `agents`. Defaults to () => true (fail-open).
 * @param {(hookData: object) => string|null} [opts.getTicketId]
 *   Extracts ticket ID from hook data or environment. If omitted, checks are skipped.
 *
 * @returns {{ check: (toolName: string, toolInput: object, hookData?: object) => ArtifactCheckResult }}
 */
function createArtifactProtector(opts) {
  const { artifacts, getStepInProgress, isRunningInAgent = () => true, getTicketId } = opts;

  function check(toolName, toolInput, hookData) {
    const target = matchWriteTarget(artifacts, toolName, toolInput, hookData);
    if (!target) return { blocked: false };
    const { bn, filePath, rule } = target;

    // Get ticket context
    const ticketId = getTicketId ? getTicketId(hookData) : null;
    if (!ticketId) return { blocked: false }; // No ticket context → allow (fail-open)

    // Only protect files within the ticket's folder (use path separator to avoid partial matches)
    if (!filePath.includes(`/${ticketId}/`) && !filePath.endsWith(`/${ticketId}`)) {
      return { blocked: false };
    }

    const currentStep = getStepInProgress(ticketId);
    return (
      checkStepGate(rule, currentStep, bn) ||
      checkAgentGate(rule, hookData, isRunningInAgent, bn) ||
      checkPerTaskPath({ bn, filePath, toolName, ticketId, currentStep }) ||
      checkContentGuard(rule, toolName, toolInput, currentStep, bn) || { blocked: false }
    );
  }

  return { check, matchesRule };
}

module.exports = { createArtifactProtector, matchesRule, bashReferencesBasename };
