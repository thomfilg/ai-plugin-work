#!/usr/bin/env node

/**
 * capture-usage.js — PostToolUse hook for /work (GH-311).
 *
 * After each agent-dispatch tool completion (Task/Agent/spawn_agent), this
 * hook:
 * 1. Extracts usage figures from the tool response — the structured claude
 *    Task fields (`totalTokens` / `totalToolUseCount` / `totalDurationMs`)
 *    when present, else a `<usage>` text block (total_tokens / tool_uses /
 *    duration_ms) via `parseUsageBlock()`.
 * 2. Checks this terminal owns an active /work session (`.work.pid` marker,
 *    session/worktree-scoped like work-auto-advance).
 * 3. Attributes the record to the ticket's current step (`.work-state.json`
 *    `currentStep`, 1-indexed into ALL_STEPS) and the dispatched agent type.
 * 4. Appends a `kind:'usage'` row to `.work-actions.json` via the guarded
 *    `appendUsage()` writer, feeding the reports-step `cost-report.md`.
 *
 * Fail-open: any error → exit 0 silently. A response with no usage signal
 * (older runtimes) or a foreign-session marker is a silent no-op — usage
 * capture must never break or cross-wire a workflow.
 */

const fs = require('fs');
const path = require('path');
const hookCommon = require(path.join(__dirname, '..', 'lib', 'hook-common'));

hookCommon.installFailOpen();

/**
 * Resolve the ticket's active step name from `.work-state.json`.
 * `currentStep` is 1-indexed into ALL_STEPS (see print-current-step.js).
 * Missing/invalid state attributes the row to 'unknown' rather than dropping
 * the usage figures.
 */
function readStateStep(tasksBase, ticket) {
  let safe = ticket;
  try {
    safe = require(path.join(__dirname, '..', '..', 'lib', 'config')).safeTicketId(ticket);
  } catch {
    /* fall back to the raw id */
  }
  try {
    const statePath = path.join(tasksBase, safe, '.work-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const { ALL_STEPS } = require(path.join(__dirname, '..', 'step-registry'));
    const num = Number(state && state.currentStep);
    if (Number.isFinite(num) && num >= 1 && num <= ALL_STEPS.length) {
      return ALL_STEPS[num - 1];
    }
  } catch {
    /* missing/corrupt state file */
  }
  return 'unknown';
}

/** Finite number or 0. */
function fin(n) {
  return Number.isFinite(n) ? n : 0;
}

/** Flatten a tool_response (string / content-block array / {content}) to text. */
function collectText(resp) {
  if (typeof resp === 'string') return resp;
  const blocks = Array.isArray(resp)
    ? resp
    : resp && typeof resp === 'object'
      ? resp.content
      : null;
  if (Array.isArray(blocks)) {
    return blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  }
  return null;
}

/**
 * Extract `{ totalTokens, toolUses, durationMs }` from a raw tool_response.
 * Prefers the structured claude Task fields; falls back to the `<usage>` text
 * block (codex / string-form responses). Returns null when the response
 * carries no usage signal at all.
 */
function extractUsage(rawResponse, evt) {
  if (rawResponse && typeof rawResponse === 'object' && !Array.isArray(rawResponse)) {
    const tokens = Number(rawResponse.totalTokens);
    const tools = Number(rawResponse.totalToolUseCount);
    const duration = Number(rawResponse.totalDurationMs);
    if (Number.isFinite(tokens) || Number.isFinite(tools) || Number.isFinite(duration)) {
      return { totalTokens: fin(tokens), toolUses: fin(tools), durationMs: fin(duration) };
    }
  }
  const { parseUsageBlock } = require(path.join(__dirname, '..', 'lib', 'work-actions'));
  const text = collectText(rawResponse) || evt.toolResponseText;
  return typeof text === 'string' ? parseUsageBlock(text) : null;
}

/** Dispatched agent type: subagent_type / agentType input field, else tool name. */
function resolveAgentType(evt) {
  const input = evt.toolInput || {};
  return input.subagent_type || input.agentType || evt.rawToolName || 'unknown';
}

function main() {
  const hookData = hookCommon.readHookData();
  if (!hookData) process.exit(0);

  const { rt, evt } = hookCommon.normalizePostToolEvent(hookData);

  // Guard: do NOT fire inside sub-agents — the orchestrator's own Task
  // completion is the single attribution point for a dispatch.
  if (rt.isSubagentContext(evt)) process.exit(0);

  // Only agent-dispatch tools carry a usage footer worth attributing; a Bash
  // result that happens to print '<usage>' (e.g. cat of a transcript) must
  // not be recorded.
  if (evt.toolKind !== 'agent') process.exit(0);

  const usage = extractUsage(hookData.tool_response, evt);
  if (!usage) process.exit(0);

  const found = hookCommon.findRecentWorkMarker();
  if (!found || !found.marker.ticket) process.exit(0);

  const { appendUsage } = require(path.join(__dirname, '..', 'lib', 'work-actions'));
  appendUsage(found.marker.ticket, {
    step: readStateStep(found.tasksBase, found.marker.ticket),
    agentType: resolveAgentType(evt),
    totalTokens: usage.totalTokens,
    toolUses: usage.toolUses,
    durationMs: usage.durationMs,
  });

  process.exit(0);
}

main();
