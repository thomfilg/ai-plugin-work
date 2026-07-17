/**
 * agent-identity.js — the ONE canonical entry point for agent-identity
 * questions in hooks (GH-767).
 *
 * New hooks import THIS module. Never probe `process.env.CLAUDE_CURRENT_AGENT`,
 * payload `agent_type`/`agent_name`/`subagent_type`, or transcript markers
 * directly — the grep-guard test rejects new inline reads.
 *
 * ## Inputs (signal precedence, highest trust first)
 *   1. Hook payload (raw stdin JSON) — `agent_type` is the documented
 *      self-identity field; codex sets no CLAUDE_* env vars, so payload-first
 *      is the dual-runtime rule (design C12).
 *   2. Transcript structural markers — Task-dispatch records
 *      (`attributionAgent` / `isSidechain`), active Task/spawn_agent scans,
 *      legacy frontmatter. Codex rollouts route through the dual-runtime
 *      reader (`runtime/transcript.js detectAgentContext`).
 *   3. Env (`CLAUDE_CURRENT_AGENT`) — spoofable, lowest trust (see
 *      `envAgentName`).
 *
 * ## The six identity questions (distinct — never conflate them)
 *   1. `isRunningInAgent(transcriptPath, aliases, hookData)` — "am I agent X?"
 *      Walk: payload → env → codex rollout → structural initial-prompt
 *      markers → active Task scan → legacy frontmatter.
 *   2. `isDispatchedAgentContext(transcriptPath, hookData)` — "am I ANY
 *      dispatched agent?" (GH-695). Fail-open false; DELIBERATELY
 *      env-sensitive: a leaked env var only blocks a terminal bypass with a
 *      message naming the leaked var.
 *   3. `isSubagentContext(evt)` — canonical-event leg (`runtime/payload.js`),
 *      DELIBERATELY env-BLIND (GH-696 / PR #718): an env leak here would
 *      silently mute auto-advance in a main session — a liveness failure
 *      with no error message. Questions 2 and 3 differ in fail direction on
 *      purpose; DO NOT merge them.
 *   4. `payloadAgentName(hookData)` — raw self-identity string from the
 *      payload (`agent_type || agent_name || subagent_type`), normalized.
 *   5. `dispatchTargetAgent(toolInput)` — the agent being DISPATCHED
 *      (`tool_input.subagent_type`). A dispatch target is NEVER self-identity
 *      (the agent-hook-dispatcher false-match bug class).
 *   6. `envAgentName()` — `CLAUDE_CURRENT_AGENT` probe. Spoofable: any
 *      process can export it, and tmux global env leaks it across sessions.
 *      Lowest trust; never use it as the sole gate for anything
 *      security-relevant.
 *
 * ## The #665 rule (prohibition)
 * Name-substring matching against user prose is only permitted inside a
 * transcript POSITIVELY identified as a sidechain (`isSidechain` /
 * `attributionAgent` markers). Never in main-session text, never in command
 * text: a main session whose prompt merely says "use the commit-writer
 * agent" must not be classified as commit-writer (GH-665 bricked-session
 * incident class).
 *
 * ## Fail directions
 * All accessors fail open: read/parse errors → `false` / `''` (established
 * hook convention). `isDispatchedAgentContext` fail-open false per GH-695;
 * `isSubagentContext` env-blind per GH-696 — preserved exactly, see above.
 *
 * ## Observability
 * `classifyIdentity()` reports the deciding signal as `{ decision, signal }`
 * and, when `ENFORCE_HOOK_DEBUG` is set, logs exactly one
 * `[agent-identity] <signal>: <detail>` line to stderr.
 *
 * Internal legs (required, never re-implemented here):
 *   - ./agent-detection.js — claude scanning leg (characterization-locked)
 *   - ./transcript-markers.js — structural marker helpers + GH-695 predicate
 *   - ./runtime/transcript.js — dual-format transcript reader (locked)
 *   - ./runtime/payload.js — canonical-event leg (GH-696-locked)
 */

const {
  isRunningInAgent,
  isSubagentFromTranscript,
  isSubagentFromInitialPrompt,
  isDispatchedAgentContext,
  isAgentFromFrontmatter,
  normalizeAgentName,
  matchesAlias,
} = require('./agent-detection');
const { readInitialMarkers } = require('./transcript-markers');
const { sniffFormat, detectAgentContext } = require('./runtime/transcript');
const { isSubagentContext } = require('./runtime/payload');

/**
 * Deciding-signal names, in precedence order. Keep in sync with the
 * precedence walk in `classifyIdentity()` and the JSDoc header above.
 */
const SIGNALS = Object.freeze({
  PAYLOAD: 'payload',
  ENV: 'env',
  CODEX_ROLLOUT: 'codex-rollout',
  STRUCTURAL_MARKER: 'structural-marker',
  TASK_SCAN: 'task-scan',
  FRONTMATTER: 'frontmatter',
  NONE: 'none',
});

function debugLog(signal, detail) {
  if (process.env.ENFORCE_HOOK_DEBUG) {
    process.stderr.write(`[agent-identity] ${signal}: ${detail}\n`);
  }
}

/**
 * Question 4 — raw self-identity name from the hook payload, normalized.
 * Fallback order `agent_type || agent_name || subagent_type` (top-level
 * fields only — `tool_input.subagent_type` is a dispatch TARGET, see
 * `dispatchTargetAgent`). Non-string/missing fields are skipped; `''` on
 * any error.
 */
function payloadAgentName(hookData) {
  try {
    if (!hookData || typeof hookData !== 'object') return '';
    const raw = [hookData.agent_type, hookData.agent_name, hookData.subagent_type].find(
      (value) => typeof value === 'string' && value !== ''
    );
    return raw ? normalizeAgentName(raw) : '';
  } catch {
    return '';
  }
}

/**
 * Question 5 — the agent being DISPATCHED by a Task/Agent tool call
 * (`tool_input.subagent_type`), normalized. Never self-identity: the parent
 * making the Task call is NOT the target agent. `''` on error.
 */
function dispatchTargetAgent(toolInput) {
  try {
    const raw = toolInput && typeof toolInput === 'object' ? toolInput.subagent_type : null;
    return typeof raw === 'string' && raw !== '' ? normalizeAgentName(raw) : '';
  } catch {
    return '';
  }
}

/**
 * Question 6 — the `CLAUDE_CURRENT_AGENT` env probe, normalized.
 * SPOOFABLE and leak-prone (tmux global env): lowest-trust signal, for
 * legacy claude flows only. `''` when unset.
 */
function envAgentName() {
  try {
    const raw = process.env.CLAUDE_CURRENT_AGENT;
    return typeof raw === 'string' && raw !== '' ? normalizeAgentName(raw) : '';
  } catch {
    return '';
  }
}

/**
 * Dispatcher helper: a copy of the hook payload safe to feed to
 * self-identity detection. Strips `tool_input.subagent_type` (a dispatch
 * TARGET) so a non-Task tool that happens to carry the field can never make
 * the parent look like the target agent (extracted from
 * agent-hook-dispatcher.js). Returns the payload unchanged when there is
 * nothing to strip; never mutates the input.
 */
function activeAgentDetectionPayload(hookData) {
  try {
    if (!hookData || typeof hookData !== 'object') return hookData;
    if (hookData.tool_input && hookData.tool_input.subagent_type) {
      return { ...hookData, tool_input: { ...hookData.tool_input, subagent_type: undefined } };
    }
    return hookData;
  } catch {
    return hookData;
  }
}

/**
 * Precedence walk for classifyIdentity — mirrors isRunningInAgent's order
 * (payload → env → codex rollout → structural markers → task scan →
 * frontmatter) but reports WHICH signal decided.
 */
function classifySignal(transcriptPath, agentAliases, hookData) {
  const fromPayload = payloadAgentName(hookData);
  if (fromPayload && matchesAlias(fromPayload, agentAliases)) {
    return { decision: true, signal: SIGNALS.PAYLOAD, detail: `agent=${fromPayload}` };
  }

  const fromEnv = envAgentName();
  if (fromEnv && matchesAlias(fromEnv, agentAliases)) {
    return { decision: true, signal: SIGNALS.ENV, detail: `CLAUDE_CURRENT_AGENT=${fromEnv}` };
  }

  if (transcriptPath && sniffFormat(transcriptPath) === 'codex') {
    const decision = detectAgentContext(transcriptPath, agentAliases);
    return {
      decision,
      signal: SIGNALS.CODEX_ROLLOUT,
      detail: `spawn_agent dispatch scan → ${decision}`,
    };
  }

  if (isSubagentFromInitialPrompt(transcriptPath, agentAliases)) {
    return { decision: true, signal: SIGNALS.STRUCTURAL_MARKER, detail: 'initial-prompt markers' };
  }

  if (isSubagentFromTranscript(transcriptPath, agentAliases)) {
    return { decision: true, signal: SIGNALS.TASK_SCAN, detail: 'active Task dispatch' };
  }

  if (isAgentFromFrontmatter(transcriptPath, agentAliases)) {
    return { decision: true, signal: SIGNALS.FRONTMATTER, detail: 'legacy frontmatter name' };
  }

  return { decision: false, signal: SIGNALS.NONE, detail: 'no identity signal matched' };
}

/**
 * Debug/observability classifier: "am I agent X, and WHICH signal decided?"
 *
 * Same walk (and same verdicts) as `isRunningInAgent`, but returns
 * `{ decision, signal }` where `signal` names the deciding step
 * (payload | env | codex-rollout | structural-marker | task-scan |
 * frontmatter | none). Emits exactly one `[agent-identity]` stderr line per
 * call when `ENFORCE_HOOK_DEBUG` is set. Fail-open `{ decision: false,
 * signal: 'none' }` on error.
 */
function classifyIdentity(transcriptPath, agentAliases, hookData) {
  let result;
  try {
    result = classifySignal(transcriptPath, agentAliases || [], hookData);
  } catch {
    result = { decision: false, signal: SIGNALS.NONE, detail: 'classification error' };
  }
  debugLog(result.signal, result.detail);
  return { decision: result.decision, signal: result.signal };
}

module.exports = {
  // Re-exported legs (see contract header)
  isRunningInAgent,
  isDispatchedAgentContext,
  isSubagentContext,
  isSubagentFromInitialPrompt,
  normalizeAgentName,
  matchesAlias,
  readInitialMarkers,
  // New accessors (GH-767)
  payloadAgentName,
  dispatchTargetAgent,
  envAgentName,
  classifyIdentity,
  activeAgentDetectionPayload,
  // Signal-name constants (shared with the JSDoc precedence table)
  SIGNALS,
};
