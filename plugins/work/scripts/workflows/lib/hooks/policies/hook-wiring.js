/**
 * policies/hook-wiring.js
 *
 * Protector/gate wiring for enforce-step-workflow.js. Builds every stateful
 * checker the hook entry orchestrates:
 *
 *   - loadStateFile (workflow-context reader bound to the tasks base)
 *   - artifactProtector (Rule 4), stateFileProtector (Rule 3),
 *     followUpStateProtector (Rule 3c)
 *   - state-script gate (terminal bypasses + Rule 3b, GH-276/GH-338/GH-89)
 *   - agent-gate rule (Rule 5 token mint, GH-184)
 *   - checkStateFileRule / checkProtectors: pure decision wrappers that
 *     RETURN block results — the hook entry owns didBlock/stderr/exit.
 */

const { createArtifactProtector } = require('../../protect-artifact-files');
const {
  buildBasenameToHintMap,
  createStateFileProtector,
  createFollowUpStateProtector,
} = require('./state-protection');
const { SAFE_SUBCOMMANDS, TRUSTED_SCRIPT_DIRS, debugLogCandidatePath } = require('./hook-config');
const { createStateLoader, getCurrentStep } = require('./workflow-context');
const { createStateScriptGate, DISPATCHED_AGENT_GUIDANCE } = require('./state-script-gate');
const { createAgentGateRule } = require('./agent-gate-rule');
const { mergeAgentGatedScripts } = require('./workflow-discovery');

function buildProtectors(deps, loadStateFile, exemptScripts) {
  const artifactProtector = createArtifactProtector({
    artifacts: deps.artifactRules,
    getStepInProgress: (ticketId) => {
      const state = loadStateFile(ticketId, '.work-state.json');
      return state?.stepStatus
        ? deps.workSteps.find((s) => state.stepStatus[s] === 'in_progress') || null
        : null;
    },
    isRunningInAgent: deps.isRunningInAgent,
    getTicketId: deps.getTicketId,
  });

  const stateFileProtector = createStateFileProtector({
    protectedBasenames: deps.protectedBasenames,
    exemptScripts,
    safeSubcommands: SAFE_SUBCOMMANDS,
    trustedDirs: TRUSTED_SCRIPT_DIRS,
  });

  // Protected follow-up PR state files — only the follow-up-pr agent during follow_up step
  const followUpStateProtector = createFollowUpStateProtector({
    getTicketId: deps.getTicketId,
    loadStateFile,
    isRunningInAgent: deps.isRunningInAgent,
    STEPS: deps.steps,
  });

  return { artifactProtector, stateFileProtector, followUpStateProtector };
}

// Command shapes covered by the terminal-step bypasses (GH-276/GH-338) — used
// only to decide whether a still-blocked Rule 3 result deserves the GH-695
// dispatched-agent guidance in its message.
const TERMINAL_BYPASS_SHAPE =
  /(?:work-state\.js['"]?\s+['"]?complete|session-guard\.js['"]?\s+['"]?(?:finish|reveal|complete))\b/;

// Apply the terminal-step bypasses to a blocked Rule 3 result (Bash only).
function applyTerminalBypasses(rule3, gate, toolName, toolInput, ticketId, hookData) {
  if (toolName !== 'Bash') return;
  const cmd = String(toolInput?.command || '').trim();
  // Step-conditional bypass: work-state.js complete is allowed at the terminal step (GH-276)
  if (
    rule3.match === '.work-state.json' &&
    gate.isTerminalCompleteBypass(cmd, ticketId, hookData)
  ) {
    rule3.blocked = false;
  }
  // Step-conditional bypass: session-guard.js finish/reveal/complete at terminal step (GH-338)
  // Not gated on rule3.match — session-guard.js may trigger Rule 3 via different state files
  if (rule3.blocked && gate.isTerminalSessionGuardBypass(cmd, ticketId, hookData)) {
    rule3.blocked = false;
  }
}

/**
 * Rule 3 wrapper: state-file protection with the terminal-step bypasses.
 * Fail-open when no ticket context: without a workflow there is nothing to
 * protect, and the hook should not block tool use it cannot reason about.
 */
function makeStateFileRule({ stateFileProtector, gate, basenameToHint, workflows }) {
  return function checkStateFileRule(toolName, toolInput, ticketId, hookData) {
    const rule3 = ticketId ? stateFileProtector.check(toolName, toolInput) : { blocked: false };
    if (!rule3.blocked) return rule3;
    applyTerminalBypasses(rule3, gate, toolName, toolInput, ticketId, hookData);
    if (rule3.blocked) {
      const hint = basenameToHint[rule3.match] || workflows[0].transitionHint;
      rule3.message = rule3.message + `Use: ${hint} ${ticketId} <step>\n`;
      // GH-695: name the correct move for a dispatched agent that attempted
      // the terminal bypass (and the leaked-env cause for an orchestrator).
      if (
        toolName === 'Bash' &&
        TERMINAL_BYPASS_SHAPE.test(String(toolInput?.command || '')) &&
        gate.isDispatchedContext(hookData)
      ) {
        rule3.message += DISPATCHED_AGENT_GUIDANCE;
      }
    }
    return rule3;
  };
}

// Rule 3c (follow-up PR state files) then Rule 4 (step-gated artifact files).
// Rule 4 must run BEFORE skipRemainingChecks — Edit/Write/MultiEdit need it.
function makeProtectorsRule(protectors) {
  return function checkProtectors(toolName, toolInput, hookData) {
    const rule3c = protectors.followUpStateProtector.check(toolName, toolInput, hookData);
    if (rule3c.blocked) return rule3c;
    return protectors.artifactProtector.check(toolName, toolInput, hookData);
  };
}

/**
 * Create the hook's protector/gate set.
 *
 * @param {object} deps
 * @param {object[]} deps.workflows — discovered workflow definitions
 * @param {object[]} deps.artifactRules — merged artifact rules
 * @param {Set<string>} deps.protectedBasenames — PROTECTED_STATE_BASENAMES
 * @param {Set<string>} deps.exemptScripts — EXEMPT_SCRIPTS (Vector 3)
 * @param {string} deps.tasksBase
 * @param {Function} deps.safeTicketPath
 * @param {object} deps.steps — /work STEPS registry
 * @param {string[]} deps.workSteps — /work ALL_STEPS
 * @param {Function} deps.getTicketId
 * @param {Function} deps.isRunningInAgent
 * @param {Function} deps.isDispatchedAgentContext — GH-695 dispatched-agent detector
 * @param {Function} deps.normalizeAgentName
 * @param {string} deps.hookFilename — enforce-step-workflow.js path
 */
function createHookWiring(deps) {
  const loadStateFile = createStateLoader({
    tasksBase: deps.tasksBase,
    safeTicketPath: deps.safeTicketPath,
  });

  // Map each protected basename to its workflow's transition hint
  const basenameToHint = buildBasenameToHintMap(deps.workflows);

  // Agent-gated writer scripts — merged across all discovered workflows
  // (GH-206 Task 12, see workflow-discovery.js).
  const agentGatedScripts = mergeAgentGatedScripts(deps.workflows);

  // Vector 3 (script-content bypass) of the state-file protector must skip
  // agent-gated writer scripts. Those scripts legitimately reference protected
  // basenames (e.g. tdd-phase-state.js calls appendEnforcementAudit on
  // .work-actions.json) and Rule 5 is the authoritative gate for them
  // (agent identity + step + token mint). Without this, Rule 3 would block the
  // invocation before Rule 5 ever runs.
  const agentGatedExemptScripts = new Set([
    ...deps.exemptScripts,
    ...Object.keys(agentGatedScripts),
  ]);

  const protectors = buildProtectors(deps, loadStateFile, agentGatedExemptScripts);

  // Terminal-step bypasses (GH-276/GH-338) + Rule 3b sub-command gate (GH-89)
  const gate = createStateScriptGate({
    trustedDirs: TRUSTED_SCRIPT_DIRS,
    safeSubcommands: SAFE_SUBCOMMANDS,
    loadStateFile,
    getCurrentStep,
    workSteps: deps.workSteps,
    tasksBase: deps.tasksBase,
    safeTicketPath: deps.safeTicketPath,
    debugLogCandidatePath,
    // GH-695: terminal bypasses reject any dispatched-agent context
    isDispatchedAgentContext: deps.isDispatchedAgentContext,
  });

  // Rule 5: agent-gated writer scripts (agent identity + step + token mint)
  const agentGateRule = createAgentGateRule({
    agentGatedScripts,
    trustedDirs: TRUSTED_SCRIPT_DIRS,
    isRunningInAgent: deps.isRunningInAgent,
    normalizeAgentName: deps.normalizeAgentName,
    loadStateFile,
    workSteps: deps.workSteps,
    tasksBase: deps.tasksBase,
    safeTicketPath: deps.safeTicketPath,
    debugLogCandidatePath,
    hookFilename: deps.hookFilename,
  });

  const checkStateFileRule = makeStateFileRule({
    stateFileProtector: protectors.stateFileProtector,
    gate,
    basenameToHint,
    workflows: deps.workflows,
  });

  return {
    loadStateFile,
    checkStateFileRule, // Rule 3 (+ terminal bypasses); returns block result
    checkProtectors: makeProtectorsRule(protectors), // Rules 3c + 4
    checkUnsafeSubcommands: gate.checkUnsafeSubcommands, // Rule 3b
    agentGateRule, // Rule 5
  };
}

module.exports = {
  createHookWiring, // protector/gate wiring for the hook entry
};
