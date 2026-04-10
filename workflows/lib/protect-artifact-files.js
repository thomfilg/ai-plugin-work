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

/** Node.js fs write calls executed via Bash */
const NODE_FS_WRITES = /\b(?:writeFileSync|appendFileSync|writeFile|createWriteStream)\b/;

/**
 * @typedef {object} ArtifactRule
 * @property {string} [basename] — exact file basename to match
 * @property {RegExp} [pattern] — regex to match against file basename
 * @property {string} step — the workflow step that owns this artifact
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

    // Check 1: Step must be in_progress
    const currentStep = getStepInProgress(ticketId);
    if (currentStep !== rule.step) {
      return {
        blocked: true,
        file: bn,
        rule: 'step',
        message:
          `BLOCKED: Cannot write ${bn} — step '${rule.step}' is not in_progress.\n` +
          `Current step: ${currentStep || '(none)'}\n` +
          `Only the ${rule.step} step may create/modify this file.\n`,
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

    return { blocked: false };
  }

  return { check, matchesRule };
}

module.exports = { createArtifactProtector, matchesRule };
