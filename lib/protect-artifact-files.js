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
 *     isRunningInAgent: (transcriptPath, agents) => boolean,
 *     ticketId: () => string|null,  // returns current ticket ID
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
 * @param {(transcriptPath: string, agents: string[]) => boolean} [opts.isRunningInAgent]
 *   Returns true if the current context is inside one of the specified agents.
 *   Only needed if any artifact rule has `agents`. Defaults to () => true (fail-open).
 * @param {(hookData: object) => string|null} [opts.getTicketId]
 *   Extracts ticket ID from hook data or environment. If omitted, checks are skipped.
 *
 * @returns {{ check: (toolName: string, toolInput: object, hookData?: object) => ArtifactCheckResult }}
 */
function createArtifactProtector(opts) {
  const {
    artifacts,
    getStepInProgress,
    isRunningInAgent = () => true,
    getTicketId,
  } = opts;

  function check(toolName, toolInput, hookData) {
    // Only check write tools
    if (!['Write', 'Edit', 'MultiEdit'].includes(toolName)) {
      return { blocked: false };
    }

    const filePath = toolInput?.file_path || '';
    if (!filePath) return { blocked: false };

    const bn = path.basename(filePath);

    // Find matching artifact rule
    const rule = artifacts.find(a => matchesRule(bn, a));
    if (!rule) return { blocked: false };

    // Get ticket context
    const ticketId = getTicketId ? getTicketId(hookData) : null;
    if (!ticketId) return { blocked: false }; // No ticket context → allow (fail-open)

    // Only protect files within the ticket's folder
    if (!filePath.includes(ticketId)) return { blocked: false };

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
      if (!isRunningInAgent(transcriptPath, rule.agents)) {
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
