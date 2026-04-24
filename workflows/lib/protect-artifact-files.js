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
    let bn, filePath, rule;

    if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
      // Vector 1: Direct file writes
      filePath = toolInput?.file_path || '';
      if (!filePath) return { blocked: false };
      bn = path.basename(filePath);
      rule = artifacts.find((a) => matchesRule(bn, a));
      if (!rule) return { blocked: false };
    } else if (toolName === 'Bash') {
      // Vector 2: Bash shell writes (>, >>, tee, cp, mv, sed -i, cat >, node -e writeFileSync)
      const cmd = String(toolInput?.command || '');
      const hasWrite =
        BASH_WRITE_OPS.test(cmd) || NODE_FS_WRITES.test(cmd) || /\bsed\s+-i\b/.test(cmd);
      if (!hasWrite) return { blocked: false };

      // Check if any artifact basename appears in the command
      for (const a of artifacts) {
        if (a.basename && cmd.includes(a.basename)) {
          bn = a.basename;
          filePath = cmd; // Use cmd as context for ticket ID check
          rule = a;
          break;
        }
        if (a.pattern) {
          // Extract potential filenames from command tokens
          const tokens = cmd.match(/[\w.-]+\.(?:md|json|txt)/g) || [];
          const match = tokens.find((t) => a.pattern.test(t));
          if (match) {
            bn = match;
            filePath = cmd;
            rule = a;
            break;
          }
        }
      }
      if (!rule) return { blocked: false };
    } else {
      return { blocked: false };
    }

    // Get ticket context
    const ticketId = getTicketId ? getTicketId(hookData) : null;
    if (!ticketId) return { blocked: false }; // No ticket context → allow (fail-open)

    // Only protect files within the ticket's folder (use path separator to avoid partial matches)
    if (!filePath.includes(`/${ticketId}/`) && !filePath.endsWith(`/${ticketId}`))
      return { blocked: false };

    // Check 1: Step must be in_progress (primary step or any allowedSteps)
    const currentStep = getStepInProgress(ticketId);
    const stepAllowed =
      currentStep === rule.step ||
      (Array.isArray(rule.allowedSteps) && rule.allowedSteps.includes(currentStep));
    if (!stepAllowed) {
      const stepsLabel = rule.allowedSteps
        ? [rule.step, ...rule.allowedSteps].join(', ')
        : rule.step;
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

    // Check 2: Agent must be authorized (if agents specified)
    if (rule.agents && rule.agents.length > 0) {
      const transcriptPath = hookData?.transcript_path;
      if (!isRunningInAgent(transcriptPath, rule.agents, hookData)) {
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
    }

    // Check 3: Per-task path enforcement — when tasks.md exists, .check.md reports
    // must go to tasks/ticketId/task${N}/ not tasks/ticketId/ root
    if (bn.endsWith('.check.md')) {
      try {
        const fs = require('fs');
        const getConfigMod = require(path.join(__dirname, 'get-config'));
        const tasksBase = getConfigMod.require('TASKS_BASE');
        // Sanitize ticketId for filesystem path (e.g. GitHub #123 → GH-123)
        const configMod = require(path.join(__dirname, 'config'));
        const safeId =
          typeof configMod.safeTicketId === 'function'
            ? configMod.safeTicketId(ticketId)
            : ticketId;
        const statePath = path.join(tasksBase, safeId, '.work-state.json');
        if (fs.existsSync(statePath)) {
          const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
          if (state.tasksMeta && state.tasksMeta.totalTasks > 0) {
            // Determine the actual file path — for Bash, extract from command string
            let actualFilePath;
            if (['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
              actualFilePath = filePath;
            } else if (toolName === 'Bash') {
              actualFilePath = extractBashTargetPath(filePath, bn);
              // If we can't extract a reliable path, fail-open (skip per-task check)
            }

            if (!actualFilePath) {
              // Can't determine path — skip per-task enforcement (fall through)
            } else {
              // Per-task mode active — check file path is under task${N}/
              // Use path.resolve to prevent bypass via relative path components
              // (e.g., ../../ticketId/file.check.md). path.relative then gives a
              // canonical relative path; we verify it doesn't escape with '..'
              // and doesn't contain path.sep (i.e., it's a direct child, not nested).
              const resolvedTicketDir = path.resolve(path.join(tasksBase, safeId));
              const resolvedFilePath = path.resolve(actualFilePath);
              const relPath = path.relative(resolvedTicketDir, resolvedFilePath);
              const isEscapingTicketDir = relPath === '..' || relPath.startsWith('..' + path.sep);
              const isWithinTicketDir =
                relPath !== '' && !isEscapingTicketDir && !path.isAbsolute(relPath);

              // Compute task number before branching — needed by both branches
              const totalTasks = state.tasksMeta.totalTasks;
              const rawCurrentIdx = state.tasksMeta.currentTaskIndex;
              const currentIdx = Number.isInteger(rawCurrentIdx) ? rawCurrentIdx : 0;
              const normalizedIdx = Math.min(Math.max(currentIdx, 0), totalTasks - 1);
              const taskNum = normalizedIdx + 1;

              // Block writes that escape the ticket directory via traversal
              if (isEscapingTicketDir) {
                return {
                  blocked: true,
                  file: bn,
                  rule: 'per-task-path',
                  message:
                    `BLOCKED: Cannot write ${bn} outside ticket directory.\n` +
                    `The resolved path escapes the ticket folder. Write your report to:\n` +
                    `  ${path.join(resolvedTicketDir, 'task' + taskNum, bn)}\n`,
                };
              }

              // Two-branch enforcement:
              // 1. Block writes at ticket root (no path separator in relPath)
              // 2. Block writes to wrong task folder (relPath doesn't start with taskN/)
              if (isWithinTicketDir && !relPath.includes(path.sep)) {
                // File is at ticket root (no path separator) — block and suggest correct task folder
                return {
                  blocked: true,
                  file: bn,
                  rule: 'per-task-path',
                  message:
                    `BLOCKED: Cannot write ${bn} at ticket root.\n` +
                    `Per-task mode is active for this ticket. Write your report to the task folder instead:\n` +
                    `  ${path.join(resolvedTicketDir, 'task' + taskNum, bn)}\n`,
                };
              } else if (isWithinTicketDir) {
                // File is in a subdirectory — validate it's the correct task folder
                const expectedPath = 'task' + taskNum + path.sep + bn;
                if (relPath !== expectedPath) {
                  return {
                    blocked: true,
                    file: bn,
                    rule: 'per-task-path',
                    message:
                      `BLOCKED: Cannot write ${bn} to wrong task folder.\n` +
                      `You are working on task ${taskNum}. Write your report to:\n` +
                      `  ${path.join(resolvedTicketDir, 'task' + taskNum, bn)}\n`,
                  };
                }
              }
            } // end actualFilePath else
          }
        }
      } catch {
        // fail-open
      }
    }

    // Check 4: Content guard (if specified on the rule)
    if (rule.contentGuard && ['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
      let guardContent = '';
      if (toolName === 'Write') {
        guardContent = toolInput?.content || '';
      } else if (toolName === 'Edit' || toolName === 'MultiEdit') {
        // Read existing file and apply edit in memory to get resulting content
        try {
          const fs = require('fs');
          const existing = fs.readFileSync(toolInput?.file_path, 'utf-8');
          const oldStr = toolInput?.old_string || '';
          const newStr = toolInput?.new_string || '';
          if (oldStr && newStr) {
            guardContent = existing.replace(oldStr, newStr);
          } else {
            guardContent = existing; // Can't simulate edit, check existing
          }
        } catch {
          guardContent = toolInput?.new_string || ''; // File doesn't exist yet, fall back
        }
      }
      if (guardContent) {
        const guardResult = rule.contentGuard(guardContent, currentStep);
        if (guardResult.blocked) {
          return {
            blocked: true,
            file: bn,
            rule: 'content',
            message: guardResult.message,
          };
        }
      }
    }

    return { blocked: false };
  }

  return { check, matchesRule };
}

module.exports = { createArtifactProtector, matchesRule };
