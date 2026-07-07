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
// Shared resolver for codex apply_patch write targets (design C6).
const { resolveApplyPatchTargets } = require('./apply-patch-targets');
// Check 3 (per-task .check.md routing) lives in its own module.
const { checkPerTaskPath } = require('./artifact-per-task-path');

/** Shell write operators — redirects, tee, cp, mv, dd */
const BASH_WRITE_OPS = /(?:>{1,2}|\btee\b|\bcp\b|\bmv\b|\bdd\b.*\bof=)/;

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
  for (const resolved of resolveApplyPatchTargets(toolInput?.command, hookData)) {
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
