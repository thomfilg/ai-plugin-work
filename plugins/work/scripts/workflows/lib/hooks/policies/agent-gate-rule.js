/**
 * policies/agent-gate-rule.js
 *
 * Rule 5 of enforce-step-workflow.js: enforce agent identity for agent-gated
 * writer scripts. When a Bash command invokes a writer script (e.g.
 * write-qa-report.js), verify:
 *
 *   1. The script resolves under a trusted directory
 *   2. The caller is an authorized agent (from the gated entry's `agents`)
 *   3. The correct workflow step is active (from `step`) — per script (GH-184)
 *
 * On success, mints a write token (plus companion tokens) for the script to
 * consume. On violation, returns { blocked: true, message } — the hook entry
 * owns didBlock/stderr/exit. The script itself also validates,
 * providing defense-in-depth.
 */

const fs = require('fs');
const path = require('path');

const { getNodeInvocations } = require('./command-matching');
const { isTrustedScriptPath, expandPluginRoot } = require('./agent-authorization');
const { envAgentName, dispatchTargetAgent, payloadAgentName } = require('../../agent-identity');
const { logHookError } = require('../../hook-error-log');
const { tokenPath, ensureTokenDir } = require('../../scripts/write-report');

// (Patch 11) Transient stderr logging gated behind debug env var
const DEBUG = !!process.env.ENFORCE_HOOK_DEBUG;

function loadTokenLog() {
  try {
    return require('../../next-script-log').logTokenEvent;
  } catch {
    return () => {};
  }
}

function untrustedScriptMessage(scriptBase, scriptPath, trustedDirs) {
  const trustedSample = trustedDirs[0] || '<plugin>/scripts/workflows';
  return (
    `BLOCKED: Script ${scriptBase} is not in a trusted directory.\n` +
    `  Resolved path: ${scriptPath}\n` +
    `  Trusted root example: ${trustedSample}\n` +
    `\nWHAT TO DO INSTEAD:\n` +
    `  Use an ABSOLUTE path under \${CLAUDE_PLUGIN_ROOT}/scripts/workflows/...\n` +
    `  Avoid relative paths like ../../scripts/... — they may not normalize to a trusted dir.\n`
  );
}

function unauthorizedAgentMessage(scriptBase, allowedAgents, ticketId) {
  const primaryAgent = allowedAgents[0];
  return (
    `BLOCKED: Cannot call ${scriptBase} — not running in an authorized agent.\n` +
    `  Allowed agents: ${allowedAgents.join(', ')}\n` +
    `\nWHAT TO DO INSTEAD:\n` +
    `  Re-dispatch this invocation through the Task tool so it runs inside the\n` +
    `  authorized agent's subprocess (where the hook can mint the write token).\n` +
    `\n  Example:\n` +
    `    Task(\n` +
    `      subagent_type: "${primaryAgent}",\n` +
    `      prompt: "node ${scriptBase} ${ticketId || '<TICKET>'} ...your args..."\n` +
    `    )\n` +
    `\n  Do NOT invoke ${scriptBase} directly from the orchestrator/main session.\n` +
    `  Do NOT stash source files to /tmp to fake test failures — that is fabricated\n` +
    `  TDD evidence and forbidden by user rules.\n`
  );
}

function wrongStepMessage(scriptBase, currentStep, requiredStep, ticketId) {
  return (
    `BLOCKED: Cannot issue write token — step '${currentStep}' is active, not '${requiredStep}'.\n` +
    `  Script ${scriptBase} can only be called during the ${requiredStep} step.\n` +
    `\nWHAT TO DO INSTEAD:\n` +
    `  The workflow has moved past '${requiredStep}'. Do NOT try to record evidence\n` +
    `  for a previous step now — that artifact window has closed.\n` +
    `  If the workflow is genuinely stuck, run:\n` +
    `    node \${CLAUDE_PLUGIN_ROOT}/scripts/workflows/work/work-next.js ${ticketId || '<TICKET>'}\n` +
    `  and follow the action it prints for the CURRENT step ('${currentStep}').\n`
  );
}

// Enforce per-script step gating (GH-184). Returns a block message or null.
function checkStepGate(deps, scriptBase, gatedEntry, ticketId) {
  if (!ticketId) return null;
  const state = deps.loadStateFile(ticketId, '.work-state.json');
  const currentStep = state?.stepStatus
    ? deps.workSteps.find((s) => state.stepStatus[s] === 'in_progress') || null
    : null;
  const requiredStep = gatedEntry.step;
  const wrongStepActive = currentStep && currentStep !== requiredStep;
  if (wrongStepActive) {
    return wrongStepMessage(scriptBase, currentStep, requiredStep, ticketId);
  }
  return null;
}

// Agent + step verified — pick the agent identity to stamp into the token.
function detectAgent(deps, allowedAgents, hookData) {
  const norm = deps.normalizeAgentName;
  const envAgent = envAgentName();
  if (envAgent && allowedAgents.some((a) => norm(a) === envAgent)) return envAgent;
  const hd = dispatchTargetAgent(hookData?.tool_input);
  if (hd && allowedAgents.some((a) => norm(a) === hd)) return hd;
  return allowedAgents[0];
}

// Key by ticket so parallel sessions on different tickets do not clobber
// each other's tokens (real incident: ECHO-4465 and ECHO-4630 task-next.js
// runs colliding on the same /tmp/.claude-write-tokens/task-next.js file).
// When ticketId is null (no ticket context), falls back to the legacy
// unkeyed path.
//
// Strip ENFORCE_HOOK_SUFFIX from the ticket-key: getTicketId() appends the
// suffix (`<ticket>/<suffix>`) for phase-aware STATE-file paths, but
// consumers like tdd-phase-state.js look up tokens by the BARE ticket arg
// from the CLI (no suffix). Keying tokens with the suffix would make
// consumers miss them.
function writeOneToken(basename, tokenData, ticketId) {
  const bareTicket = ticketId ? ticketId.split('/')[0] : ticketId;
  const tp = tokenPath(basename, bareTicket);
  try {
    fs.unlinkSync(tp);
  } catch {
    /* may not exist */
  }
  const fd = fs.openSync(tp, 'wx', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(tokenData));
  } finally {
    fs.closeSync(fd);
  }
}

// Issue a write token for the script to consume, plus companion tokens:
// scripts the gated script calls internally via spawnSync (which bypasses
// the PreToolUse hook) get a matching token so the chained writer can
// authenticate without a second hook trip.
function mintTokens(deps, scriptBase, gatedEntry, detectedAgent, ticketId) {
  try {
    ensureTokenDir();
    const tokenData = {
      agent: deps.normalizeAgentName(detectedAgent),
      timestamp: Date.now(),
      tasksBase: ticketId ? path.join(deps.tasksBase, deps.safeTicketPath(ticketId)) : null,
    };
    writeOneToken(scriptBase, tokenData, ticketId);
    const companions = Array.isArray(gatedEntry.companionScripts)
      ? gatedEntry.companionScripts
      : [];
    for (const companion of companions) {
      writeOneToken(companion, tokenData, ticketId);
    }
  } catch (e) {
    if (DEBUG) process.stderr.write(`WARNING: Failed to write token: ${e.message}\n`);
    logHookError(deps.hookFilename, e, { phase: 'issueWriteToken', scriptBase });
  }
}

// Check one gated invocation. Returns a block message or null (minted).
function checkGatedInvocation(deps, scriptBase, scriptPath, gatedEntry, hookData, ticketId) {
  const allowedAgents = gatedEntry.agents;
  deps.debugLogCandidatePath(scriptPath);
  if (!isTrustedScriptPath(scriptPath, deps.trustedDirs)) {
    return untrustedScriptMessage(scriptBase, scriptPath, deps.trustedDirs);
  }

  // Verify agent identity
  const transcriptPath = hookData?.transcript_path;
  if (!deps.isRunningInAgent(transcriptPath, allowedAgents, hookData)) {
    return unauthorizedAgentMessage(scriptBase, allowedAgents, ticketId);
  }

  const stepBlock = checkStepGate(deps, scriptBase, gatedEntry, ticketId);
  if (stepBlock) return stepBlock;

  mintTokens(deps, scriptBase, gatedEntry, detectAgent(deps, allowedAgents, hookData), ticketId);
  return null;
}

// Telemetry: log EVERY node-invocation seen by Rule 5, gated or not.
// Helps diagnose why a gated script's mint path isn't being reached.
function logRule5Checked(tokenLog, deps, scriptBase, scriptPath, gatedEntry, ticketId) {
  tokenLog('rule5-checked', {
    scriptBase,
    scriptPath,
    gated: Boolean(gatedEntry),
    gatedKeys: Object.keys(deps.agentGatedScripts).slice(0, 20),
    ticketId: ticketId || null,
  });
}

function logRule5Match(tokenLog, scriptBase, scriptPath, ticketId, cmd, hookData) {
  tokenLog('rule5-match', {
    scriptBase,
    scriptPath,
    ticketId: ticketId || null,
    cmd: cmd.slice(0, 300),
    envAgent: envAgentName() || null,
    subagentType: dispatchTargetAgent(hookData?.tool_input) || null,
    hookAgentType: payloadAgentName(hookData) || null,
  });
}

/**
 * Scan a Bash command for agent-gated writer-script invocations.
 * Mints tokens for authorized invocations; returns the first violation as
 * { blocked: true, message } or null when nothing blocks.
 */
function check(deps, cmd, hookData, ticketId) {
  const tokenLog = loadTokenLog();
  const nodeMatches = getNodeInvocations(cmd);
  for (const nodeExec of nodeMatches) {
    const scriptPath = expandPluginRoot(nodeExec[1] || nodeExec[2] || nodeExec[3]);
    const scriptBase = path.basename(scriptPath);
    const gatedEntry = deps.agentGatedScripts[scriptBase];
    logRule5Checked(tokenLog, deps, scriptBase, scriptPath, gatedEntry, ticketId);
    if (!gatedEntry) continue;
    logRule5Match(tokenLog, scriptBase, scriptPath, ticketId, cmd, hookData);
    const message = checkGatedInvocation(
      deps,
      scriptBase,
      scriptPath,
      gatedEntry,
      hookData,
      ticketId
    );
    if (message) return { blocked: true, message };
  }
  return null;
}

/**
 * Create the Rule 5 checker bound to the hook's runtime context.
 *
 * @param {object} deps
 * @param {object} deps.agentGatedScripts — AGENT_GATED_SCRIPTS map
 * @param {string[]} deps.trustedDirs — realpath-normalised TRUSTED_SCRIPT_DIRS
 * @param {Function} deps.isRunningInAgent
 * @param {Function} deps.normalizeAgentName
 * @param {Function} deps.loadStateFile
 * @param {string[]} deps.workSteps — ALL_STEPS of the /work workflow
 * @param {string} deps.tasksBase
 * @param {Function} deps.safeTicketPath
 * @param {Function} deps.debugLogCandidatePath — GH-452 diagnostic
 * @param {string} deps.hookFilename — enforce-step-workflow.js path (error log key)
 */
function createAgentGateRule(deps) {
  return {
    check: (cmd, hookData, ticketId) => check(deps, cmd, hookData, ticketId),
  };
}

module.exports = {
  createAgentGateRule, // Rule 5: agent-gated writer scripts + token mint
};
