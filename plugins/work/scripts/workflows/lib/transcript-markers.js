/**
 * transcript-markers.js
 *
 * Structural subagent-marker helpers for claude JSONL transcripts, extracted
 * verbatim from agent-detection.js (file-size burndown, GH-695 change set):
 *
 *   - extractEntryText / readInitialMarkers: scan the first transcript lines
 *     for the structural markers of a Task-spawned subagent
 *     (attributionAgent / isSidechain)
 *   - isDispatchedAgentContext (GH-695): alias-agnostic "am I in ANY
 *     dispatched agent" predicate used by the terminal state-script bypasses
 *
 * agent-detection.js requires and re-exports these, so consumers keep their
 * existing import path.
 *
 * Required by: lib/agent-identity.js (the canonical GH-767 entry point —
 * new consumers import that module, not this internal leg) and
 * lib/agent-detection.js (the claude scanning leg).
 */

const fs = require('fs');

function debugLog(method, msg) {
  if (process.env.ENFORCE_HOOK_DEBUG) {
    process.stderr.write(`[agent-detection] ${method}: ${msg}\n`);
  }
}

/**
 * Extract the prose text of a single system/user transcript entry.
 * Non-message entries and unknown content shapes yield an empty string.
 */
function extractEntryText(entry) {
  if (entry.type !== 'system' && entry.type !== 'user') {
    return '';
  }
  const msgContent = entry.message?.content;
  if (typeof msgContent === 'string') {
    return msgContent;
  }
  if (Array.isArray(msgContent)) {
    return msgContent.map((i) => i.text || '').join(' ');
  }
  return '';
}

/**
 * Read the structural subagent markers from early transcript lines.
 *
 * Mirrors the per-line JSON.parse-in-try/catch pattern used by
 * isSubagentFromTranscript. Untrusted fields are read defensively.
 *
 * @param {string[]} earlyLines - The first N raw transcript lines
 * @returns {{attributionAgent: string, isSidechain: boolean, promptText: string}}
 */
function readInitialMarkers(earlyLines) {
  let attributionAgent = '';
  let isSidechain = false;
  let promptText = '';

  for (const line of earlyLines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // skip non-JSON lines
    }

    // A sidechain flag on ANY early line marks this as a subagent transcript.
    if (entry.isSidechain === true) {
      isSidechain = true;
    }

    // First attributionAgent wins — it is the authoritative identity.
    if (!attributionAgent && entry.attributionAgent) {
      attributionAgent = String(entry.attributionAgent);
    }

    // Accumulate prose from system/user messages for the gated name check.
    const text = extractEntryText(entry);
    if (text) {
      promptText = promptText ? `${promptText} ${text}` : text;
    }
  }

  return { attributionAgent, isSidechain, promptText };
}

/**
 * True when the first 10 transcript lines carry a structural subagent marker
 * (attributionAgent or isSidechain). Read/parse errors → false.
 */
function hasInitialSubagentMarkers(transcriptPath) {
  try {
    if (!fs.existsSync(transcriptPath)) return false;
    const lines = fs.readFileSync(transcriptPath, 'utf8').trim().split('\n');
    const { attributionAgent, isSidechain } = readInitialMarkers(lines.slice(0, 10));
    if (!attributionAgent && isSidechain !== true) return false;
    debugLog(
      'dispatchedContext',
      attributionAgent ? `attributionAgent=${attributionAgent}` : 'isSidechain marker'
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * GH-695: True when the current hook context belongs to ANY dispatched
 * (sub)agent, regardless of which one — alias-agnostic, no allowlist to
 * maintain. Used by the terminal state-script bypasses, which are
 * orchestrator-only: a dispatched agent must report BLOCKED instead of
 * finishing the workflow itself.
 *
 * Signals (any one suffices):
 *   - hookData.agent_type set (any value — set by Claude Code inside a subagent)
 *   - CLAUDE_CURRENT_AGENT env var set (any value)
 *   - transcriptPath contains '/subagents/' (subagent transcript location)
 *   - structural markers (attributionAgent / isSidechain) in the first 10
 *     transcript lines, via readInitialMarkers
 *
 * Fail direction: read/parse errors → false (fail-open at the hook). Failing
 * closed here would deadlock the terminal step with no in-band repair; the
 * completeWork script-side precondition is the backstop.
 *
 * @param {string} [transcriptPath] - Path to the session transcript
 * @param {object} [hookData] - Hook payload from Claude Code
 * @returns {boolean} true when this context is a dispatched agent
 */
function isDispatchedAgentContext(transcriptPath, hookData) {
  if (hookData?.agent_type) {
    debugLog('dispatchedContext', `agent_type=${hookData.agent_type}`);
    return true;
  }
  if (process.env.CLAUDE_CURRENT_AGENT) {
    debugLog('dispatchedContext', `CLAUDE_CURRENT_AGENT=${process.env.CLAUDE_CURRENT_AGENT}`);
    return true;
  }
  if (!transcriptPath) return false;
  if (String(transcriptPath).includes('/subagents/')) {
    debugLog('dispatchedContext', 'transcript path contains /subagents/');
    return true;
  }
  return hasInitialSubagentMarkers(transcriptPath);
}

module.exports = {
  extractEntryText,
  readInitialMarkers,
  isDispatchedAgentContext,
};
