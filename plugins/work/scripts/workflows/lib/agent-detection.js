/**
 * Shared agent detection utilities for Claude Code hooks.
 *
 * INTERNAL LEG — new consumers import `lib/agent-identity.js` (GH-767), the
 * canonical entry point that re-exports this module's predicates alongside
 * the payload/env accessors and documents the full identity contract. This
 * file stays byte-compatible in logic; the entry point requires this leg,
 * so this leg must never require the entry point (cycle-free by design).
 *
 * Provides reliable detection of whether code is executing inside
 * a specific subagent context, using multiple detection strategies.
 */

const fs = require('fs');
// Vendored dual-runtime adapter (see factories/runtime): sniffs the transcript
// format per file and provides the codex rollout leg (spawn_agent dispatch
// scan). The claude scanning helpers below stay byte-for-byte — they are the
// characterization-locked claude leg.
const { sniffFormat, detectAgentContext } = require('./runtime/transcript');
// Structural marker helpers + the GH-695 dispatched-agent predicate — moved
// verbatim to ./transcript-markers (file-size burndown); re-exported below.
const { readInitialMarkers, isDispatchedAgentContext } = require('./transcript-markers');

/**
 * Normalize an agent name by stripping optional namespace prefixes and lowercasing.
 * e.g. 'work-workflow:quality-checker' → 'quality-checker'
 */
function normalizeAgentName(name) {
  return String(name || '')
    .replace(/^[\w-]+:/, '')
    .toLowerCase();
}

function debugLog(method, msg) {
  if (process.env.ENFORCE_HOOK_DEBUG) {
    process.stderr.write(`[agent-detection] ${method}: ${msg}\n`);
  }
}

/**
 * True when `value` normalizes to one of the given agent aliases.
 * Falsy `value` never matches.
 */
function matchesAlias(value, agentAliases) {
  if (!value) {
    return false;
  }
  const normalized = normalizeAgentName(value);
  return agentAliases.some((alias) => normalizeAgentName(alias) === normalized);
}

/**
 * Whether a content item is a Task/Agent tool_use dispatching one of our aliases.
 */
function isMatchingTaskUse(item, agentAliases) {
  if (item.type !== 'tool_use') {
    return false;
  }
  if (item.name !== 'Task' && item.name !== 'Agent') {
    return false;
  }
  return matchesAlias(item.input?.subagent_type || '', agentAliases);
}

/**
 * Return the matching Task/Agent tool_use item for our aliases from a single
 * assistant transcript entry, or null when the entry has no matching dispatch.
 */
function matchingTaskUse(entry, agentAliases) {
  if (entry.type !== 'assistant' || !entry.message?.content) {
    return null;
  }
  const items = Array.isArray(entry.message.content)
    ? entry.message.content
    : [entry.message.content];
  return items.find((item) => isMatchingTaskUse(item, agentAliases)) || null;
}

/**
 * Whether any transcript line after `startIdx` carries a tool_result for the
 * given tool_use id (i.e. the Task dispatch has already completed).
 */
function hasToolResult(recentLines, startIdx, toolUseId) {
  return recentLines.slice(startIdx + 1).some((line) => {
    try {
      const entry = JSON.parse(line);
      if (entry.type !== 'user' || !entry.message?.content) {
        return false;
      }
      const items = Array.isArray(entry.message.content)
        ? entry.message.content
        : [entry.message.content];
      return items.some((li) => li.type === 'tool_result' && li.tool_use_id === toolUseId);
    } catch {
      return false;
    }
  });
}

/**
 * Check if we're running inside a subagent by scanning the transcript
 * for the MOST RECENT Task tool invocation that matches our agent.
 *
 * Only checks the last 200 lines. If the most recent matching Task call
 * has no tool_result yet, we're likely executing inside that agent.
 *
 * @param {string} transcriptPath - Path to the session transcript
 * @param {string[]} agentAliases - Agent names to check for
 * @returns {boolean} true if running in subagent context
 */
function isSubagentFromTranscript(transcriptPath, agentAliases) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    // Check the last 200 lines for recent Task calls (subagents may produce
    // many transcript lines between the Task invocation and subsequent tool calls)
    const recentLines = content.trim().split('\n').slice(-200);
    const ACTIVE_TASK_LINE_THRESHOLD = 200;

    // Scan in reverse to find the most recent Task tool invocation for our agent
    for (let i = recentLines.length - 1; i >= 0; i--) {
      let entry;
      try {
        entry = JSON.parse(recentLines[i]);
      } catch {
        continue;
      }

      const taskUse = matchingTaskUse(entry, agentAliases);
      if (!taskUse) {
        continue;
      }

      // Most recent Task for this agent: active (no tool_result yet) → we are it.
      const hasResult = hasToolResult(recentLines, i, taskUse.id);
      const linesFromEnd = recentLines.length - i;
      return !hasResult && linesFromEnd <= ACTIVE_TASK_LINE_THRESHOLD;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Fallback: match a legacy transcript's frontmatter `name:` line against
 * any of the agent aliases (with optional namespace prefix).
 */
function isAgentFromFrontmatter(transcriptPath, agentAliases) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }
  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    return agentAliases.some((alias) => {
      const normalized = normalizeAgentName(alias);
      // Allow optional namespace prefix (e.g. "name: work-workflow:quality-checker")
      const frontmatterPattern = new RegExp(`^name:\\s*(?:[\\w-]+:)?${normalized}\\s*$`, 'mi');
      return frontmatterPattern.test(content);
    });
  } catch {
    return false;
  }
}

/**
 * Resolve agent identity from Claude Code hookData: agent_type (Primary-B,
 * set when the hook fires inside a subagent) then tool_input.subagent_type
 * (Secondary, available when the parent invokes Task/Agent).
 */
function agentFromHookData(hookData, agentAliases) {
  const agentType = hookData?.agent_type;
  if (matchesAlias(agentType, agentAliases)) {
    debugLog('hookData', `matched agent_type=${agentType}`);
    return true;
  }
  if (agentType) debugLog('hookData', `no match for agent_type=${agentType}`);

  const subagentType = hookData?.tool_input?.subagent_type;
  if (matchesAlias(subagentType, agentAliases)) {
    debugLog('hookData', `matched subagent_type=${subagentType}`);
    return true;
  }
  if (subagentType) debugLog('hookData', `no match for subagent_type=${subagentType}`);
  return false;
}

/**
 * Check if running inside a specific agent by examining context.
 *
 * Detection methods (in priority order):
 * 1.  CLAUDE_CURRENT_AGENT env var (Primary — most reliable)
 * 1b. hookData.agent_type (Primary-B — set by Claude Code when hook fires inside a subagent)
 * 2.  hookData.tool_input.subagent_type (Secondary — available when parent invokes Task/Agent)
 * 3.  Initial prompt scanning for agent type in subagent transcript
 * 4.  Transcript scanning for active Task tool invocations
 * 5.  Frontmatter parsing for legacy transcripts
 *
 * All comparisons use normalizeAgentName() for prefix-stripping and case-insensitive matching.
 *
 * @param {string} transcriptPath - Path to the session transcript
 * @param {string[]} agentAliases - Agent names to check for
 * @param {object} [hookData] - Hook data from Claude Code (may contain tool_input.subagent_type)
 * @returns {boolean} true if running inside one of the specified agents
 */
function isRunningInAgent(transcriptPath, agentAliases, hookData) {
  // Primary: identity supplied directly on the hook payload. Payload-first is
  // the dual-runtime rule (design C12): codex sets no CLAUDE_* env vars, and
  // on claude the payload's agent_type is at least as authoritative as env.
  // (Both this and the env check only ever return true on a match, so the
  // reorder cannot change the function's verdict on claude.)
  if (agentFromHookData(hookData, agentAliases)) {
    return true;
  }

  // Primary-B: Check environment variable (claude legacy)
  const currentAgent = process.env.CLAUDE_CURRENT_AGENT;
  if (matchesAlias(currentAgent, agentAliases)) {
    debugLog('env', `matched CLAUDE_CURRENT_AGENT=${currentAgent}`);
    return true;
  }
  if (currentAgent) debugLog('env', `no match for CLAUDE_CURRENT_AGENT=${currentAgent}`);

  // Codex rollout transcripts: none of the claude scanning helpers below can
  // read them — route through the vendored reader's spawn_agent dispatch scan
  // (most recent spawn_agent for one of our aliases without its output yet).
  if (transcriptPath && sniffFormat(transcriptPath) === 'codex') {
    return detectAgentContext(transcriptPath, agentAliases);
  }

  // Quick check: If this is a subagent process, its transcript initial
  // prompt will carry a structural marker (attributionAgent / isSidechain).
  if (isSubagentFromInitialPrompt(transcriptPath, agentAliases)) {
    return true;
  }

  // Secondary: Scan transcript for active Task tool invocations
  if (isSubagentFromTranscript(transcriptPath, agentAliases)) {
    return true;
  }

  // Fallback: Transcript frontmatter (legacy)
  return isAgentFromFrontmatter(transcriptPath, agentAliases);
}

/**
 * Detect agent identity from the subagent's own transcript.
 *
 * A genuine Task-spawned subagent transcript carries positive structural
 * markers (an authoritative `attributionAgent` field and/or `isSidechain`).
 * We key on those markers rather than scanning user prose for the agent name
 * as a substring, so a MAIN session whose opening prompt merely mentions an
 * agent name is not misclassified as that agent.
 *
 * @param {string} transcriptPath - Path to the subagent's transcript
 * @param {string[]} agentAliases - Agent names to check for
 * @returns {boolean} true if initial prompt indicates this agent
 */
function isSubagentFromInitialPrompt(transcriptPath, agentAliases) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const lines = content.trim().split('\n');

    // Read the structural subagent markers from the first 10 transcript lines.
    const { attributionAgent, isSidechain, promptText } = readInitialMarkers(lines.slice(0, 10));

    // 1. Authoritative signal: the attributionAgent identity of a genuine
    //    Task-spawned subagent. When present it overrides any prose heuristic.
    if (attributionAgent) {
      const matched = matchesAlias(attributionAgent, agentAliases);
      debugLog(
        'initialPrompt',
        matched
          ? `matched attributionAgent=${attributionAgent}`
          : `no match for attributionAgent=${attributionAgent}`
      );
      return matched;
    }

    // 2. Gated fallback: only trust a bare name mention when the transcript is
    //    positively identified as a sidechain (a real subagent transcript). A
    //    main session that merely names an agent must NOT be classified as it.
    if (isSidechain) {
      return matchesNameMention(promptText, agentAliases);
    }

    // 3. No structural marker → not a subagent for these aliases.
    debugLog('initialPrompt', 'no attributionAgent and not a sidechain transcript');
    return false;
  } catch {
    return false;
  }
}

/**
 * Word-boundary match of any agent alias name within sidechain prompt text.
 * Boundaries avoid incidental substring hits (e.g. "qa" inside "quality").
 */
function matchesNameMention(promptText, agentAliases) {
  for (const alias of agentAliases) {
    const normalized = normalizeAgentName(alias);
    const boundary = new RegExp(
      `(?:^|[\\s"':,])${normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[\\s"':,])`,
      'i'
    );
    if (boundary.test(promptText)) {
      debugLog('initialPrompt', `matched isSidechain name mention=${normalized}`);
      return true;
    }
  }
  debugLog('initialPrompt', 'sidechain transcript, no alias name mention');
  return false;
}

module.exports = {
  isRunningInAgent,
  isSubagentFromTranscript,
  isSubagentFromInitialPrompt,
  isAgentFromFrontmatter,
  isDispatchedAgentContext, // GH-695 — lives in ./transcript-markers, re-exported
  normalizeAgentName,
  matchesAlias,
};
