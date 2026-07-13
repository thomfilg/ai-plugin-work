/**
 * policies/state-protection.js
 *
 * State-file protector wiring extracted from enforce-step-workflow.js.
 *
 * Builds the two file protectors used by the enforcer:
 *   - createStateFileProtector(): blocks direct writes to workflow state/evidence files
 *   - createFollowUpStateProtector(): gates follow-up PR state files to the follow-up agent
 *
 * Also exposes:
 *   - buildBasenameToHintMap(workflows): maps protected basename -> transition hint string
 */

const path = require('path');
const { basenameProtector, createFileProtector } = require('../../protect-state-files');
const { createArtifactProtector } = require('../../protect-artifact-files');
const { isExemptScriptInvocation } = require('./agent-authorization');

/**
 * Build a map of protected basename -> the transition hint string for its owning workflow.
 * Used to render targeted error messages when a write to a state file is blocked.
 */
function buildBasenameToHintMap(workflows) {
  const map = {};
  for (const wf of workflows) {
    for (const bn of [path.basename(wf.stateFile), path.basename(wf.evidenceFile)]) {
      map[bn] = wf.transitionHint;
    }
  }
  return map;
}

/**
 * Create the protector for workflow state/evidence files.
 *
 * @param {object} opts
 * @param {Set<string>} opts.protectedBasenames
 * @param {Set<string>} opts.exemptScripts
 * @param {object} opts.safeSubcommands
 * @param {string[]} opts.trustedDirs
 */
function createStateFileProtector(opts) {
  const { protectedBasenames, exemptScripts, safeSubcommands, trustedDirs } = opts;

  return createFileProtector({
    isProtected: basenameProtector(protectedBasenames),
    isExempt: (toolName, toolInput) => {
      if (toolName !== 'Bash') return false;
      return isExemptScriptInvocation(toolInput?.command, {
        exemptScripts,
        safeSubcommands,
        trustedDirs,
        protectedBasenames,
      });
    },
    formatMessage: (match, vector) =>
      `BLOCKED: Direct ${vector} to ${match} is not allowed.\n` +
      `State files must only be modified through the orchestrator/workflow-engine scripts.\n`,
  });
}

/**
 * Create the protector for follow-up PR state files.
 * Only the `follow-up-pr` agent during the `follow_up` step may write these.
 *
 * @param {object} opts
 * @param {() => string|null} opts.getTicketId
 * @param {(ticketId: string, file: string) => object|null} opts.loadStateFile
 * @param {(transcriptPath: string, agents: string[], hookData?: object) => boolean} opts.isRunningInAgent
 * @param {object} opts.STEPS — must contain a `follow_up` key matching the work-state step name
 */
function createFollowUpStateProtector(opts) {
  const { getTicketId, loadStateFile, isRunningInAgent, STEPS } = opts;

  return createFileProtector({
    isProtected: (filePath) => {
      const bn = path.basename(filePath);
      return /^follow-up-pr-.+\.json$/.test(bn) ? bn : null;
    },
    isExempt: (_toolName, _toolInput, hookData) => {
      try {
        const ticketId = getTicketId();
        if (!ticketId) return true; // fail-open: no ticket context
        const state = loadStateFile(ticketId, '.work-state.json');
        if (!state?.stepStatus) return true; // fail-open: no active workflow
        const stepInProgress = state.stepStatus[STEPS.follow_up] === 'in_progress';
        if (!stepInProgress) return false;
        return isRunningInAgent(hookData?.transcript_path, ['follow-up-pr'], hookData);
      } catch {
        return true; // fail-open
      }
    },
    formatMessage: (match, vector) =>
      `BLOCKED: Direct ${vector} to ${match} is not allowed.\n` +
      `Follow-up PR state files can only be written by the follow-up-pr agent during the follow_up step.\n`,
  });
}

// Single module.exports assignment (no prior partial assignment to overwrite).
// Re-exports createArtifactProtector so this module owns the unified view of
// protected workflow files (state + artifact) for the enforcer.
module.exports = {
  buildBasenameToHintMap, // map protected basename → transition hint
  createStateFileProtector, // state/evidence file protector
  createFollowUpStateProtector, // follow-up PR state files
  createArtifactProtector, // re-export from protect-artifact-files
};
