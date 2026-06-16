'use strict';

/**
 * Helpers for the Path A (heuristic divergence) behavior_changed flow.
 *
 * Extracted from hooks/synapsys.js to keep that dispatcher under the
 * project's max-lines / per-function complexity caps. All helpers are
 * fail-open: any internal throw degrades to a no-op, never propagates.
 */

const path = require('node:path');

const pretoolWindow = require(path.join(__dirname, '..', '..', 'lib', 'pretool-window'));
const { recordBehaviorChanged, isDisabled } = require(
  path.join(__dirname, '..', '..', 'lib', 'telemetry')
);

// Return EVERY `trigger_pretool` spec (in `Tool:pattern` form) for a memory.
// The matcher may fire on any spec, so storing only the first would
// mis-attribute the pending expectation and emit spurious divergence when
// the agent satisfied a later spec. Keep the `Tool:` prefix so the divergence
// resolver in pretool-window can gate fulfillment on tool_name — the matcher's
// own contract for `Bash:git push` is that it ONLY matches when tool_name ===
// 'Bash'. Stripping the prefix here let any tool's JSON containing the pattern
// clear the expectation, diverging from the matcher's gate.
function expectedCommandsFor(memory) {
  if (!memory || !Array.isArray(memory.triggerPretool)) return [];
  return memory.triggerPretool.map((s) => String(s).trim()).filter((s) => s.length > 0);
}

// Match the matcher's surface: trigger_pretool regexes test the serialized
// tool_input blob, so divergence resolution must compare against the same
// shape — not just `tool_input.command`. Otherwise a pattern that matches the
// JSON form but not the bare command would falsely emit `behavior_changed`
// when the agent ran a compliant follow-up.
function observedFromPayload(payload) {
  const toolInput = (payload && payload.tool_input) || {};
  const toolName = (payload && payload.tool_name) || '';
  return { toolName, blob: JSON.stringify(toolInput) };
}

function indexMemoriesByName(memories) {
  const byName = new Map();
  for (const m of memories || []) {
    if (m && m.name) byName.set(m.name, m);
  }
  return byName;
}

function emitDivergence(entry, byName, payload, observed, sessionId) {
  const mem = byName.get(entry.memoryName);
  if (!mem || isDisabled(mem)) return;
  if (!pretoolWindow.markBehaviorChanged(sessionId, mem.name)) return;
  const evidence = `expected=${entry.expected} got=${observed}`;
  try {
    recordBehaviorChanged(mem, payload, {
      reason: 'pretool-divergence',
      evidence,
    });
  } catch {
    // fail-open
  }
}

// Path A: on every PreToolUse, age existing expectations against the observed
// command. Each divergent entry produces at most one behavior_changed event
// per `(session, memory)` per Stop turn (per-turn dedup via markBehaviorChanged).
function resolveAndEmitDivergences(payload, memories, sessionId) {
  try {
    const { toolName, blob } = observedFromPayload(payload);
    const result = pretoolWindow.resolveExpectation(sessionId, blob, toolName);
    if (!result || !result.divergent) return;
    const byName = indexMemoriesByName(memories);
    for (const entry of result.expectations) {
      emitDivergence(entry, byName, payload, blob, sessionId);
    }
  } catch {
    // fail-open
  }
}

module.exports = {
  expectedCommandsFor,
  resolveAndEmitDivergences,
};
