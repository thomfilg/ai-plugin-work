/**
 * policies/hook-telemetry.js
 *
 * Fire telemetry for enforce-step-workflow.js: logs every hook invocation
 * (JSONL via next-script-log) so we can prove the hook ran. Fail-open —
 * telemetry must never block tool use.
 */

function orNull(value) {
  return value || null;
}

function buildFiredPayload(hookType, hookData) {
  const toolInput = hookData?.tool_input;
  return {
    hookType,
    toolName: orNull(hookData?.tool_name),
    cmdSnippet: toolInput?.command ? String(toolInput.command).slice(0, 200) : null,
    envAgent: orNull(process.env.CLAUDE_CURRENT_AGENT),
    subagentType: orNull(toolInput?.subagent_type),
    hookAgentType: orNull(hookData?.agent_type),
    transcriptPath: orNull(hookData?.transcript_path),
  };
}

function logHookFired(hookType, hookData) {
  try {
    const { logTokenEvent } = require('../../next-script-log');
    logTokenEvent('hook-fired', buildFiredPayload(hookType, hookData));
  } catch {
    /* fail-open */
  }
}

module.exports = {
  logHookFired, // JSONL 'hook-fired' telemetry (fail-open)
};
