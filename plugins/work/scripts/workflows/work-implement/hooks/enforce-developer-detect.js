/**
 * enforce-developer-detect.js
 *
 * Developer-agent identification for the work-implement-enforce hook:
 * payload agent_type first (both runtimes, design C12), then the transcript
 * scan — claude Task-dispatch grep byte-for-byte from the historical hook,
 * codex rollouts via the vendored dual-format reader.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { sniffFormat, readToolEvents } = require(
  path.join(__dirname, '..', '..', 'lib', 'runtime', 'transcript')
);
const { payloadAgentName, matchesAlias } = require(
  path.join(__dirname, '..', '..', 'lib', 'agent-identity')
);

// Developer agents that satisfy the requirement
const DEVELOPER_AGENTS = [
  'developer-nodejs-tdd',
  'developer-react-senior',
  'developer-react-ui-architect',
  'developer-devops',
  ...(process.env.WORK_ARCHITECT_ENABLED === '1' ? ['code-architect'] : []),
];

/**
 * Payload-first developer identification (design C12): when the hook fires
 * inside a subagent, the payload's self-identity field names it on both
 * runtimes — codex sets no CLAUDE_* env vars and its rollout transcript is
 * unreadable by the claude scan below.
 *
 * Identity is read via the canonical `lib/agent-identity.js` accessors
 * (GH-767); the DEVELOPER_AGENTS list itself stays local — WHICH agents are
 * developers is this hook's policy, not an identity primitive.
 */
function payloadIsDeveloperAgent(hookData) {
  const agentType = payloadAgentName(hookData);
  return Boolean(agentType) && matchesAlias(agentType, DEVELOPER_AGENTS);
}

/** Matches an inline persona adoption: a shell read of agents/developer-*.md. */
const CODEX_PERSONA_READ_RE = /agents\/(?:[\w-]+:)?(?:developer-[\w-]+|code-architect)\.md/;

/**
 * Codex leg of the developer-invocation scan: the rollout transcript has no
 * Task tool_use records. Count either a spawn_agent dispatch naming a
 * developer agent (TUI escape hatch) or an inline persona adoption — a shell
 * command reading a developer agents/*.md file (design C1: subagents run
 * INLINE on codex; reading the persona file is the observable dispatch).
 */
function codexDeveloperInvocation(transcriptPath) {
  try {
    for (const event of readToolEvents(transcriptPath)) {
      const input = JSON.stringify(event.input || '');
      if (event.rawName === 'spawn_agent' && /developer-/i.test(input)) return true;
      if (event.name === 'Bash' && CODEX_PERSONA_READ_RE.test(input)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if a developer agent has been invoked (transcript-based).
 * This remains transcript-based because agent invocation is a session-level
 * signal, not a persisted state.
 */
function hasDeveloperAgentBeenInvoked(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  if (sniffFormat(transcriptPath) === 'codex') {
    return codexDeveloperInvocation(transcriptPath);
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');

    // Check if any developer agent has been called via Task tool
    for (const agent of DEVELOPER_AGENTS) {
      const pattern = new RegExp(`"subagent_type"\\s*:\\s*"(work-workflow:)?${agent}"`, 'i');
      if (pattern.test(content)) {
        return true;
      }
    }

    // Also check if we're currently INSIDE a developer agent
    for (const agent of DEVELOPER_AGENTS) {
      const frontmatterPattern = new RegExp(`^name:\\s*${agent}`, 'm');
      if (frontmatterPattern.test(content)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

module.exports = { payloadIsDeveloperAgent, hasDeveloperAgentBeenInvoked };
