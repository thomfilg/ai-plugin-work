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

function patternFromSpec(spec) {
  const colon = String(spec).indexOf(':');
  if (colon === -1) return '';
  return String(spec)
    .slice(colon + 1)
    .trim();
}

// Return EVERY `trigger_pretool` pattern (after `Tool:` prefix) for a memory.
// The matcher may fire on any spec, so storing only the first pattern would
// mis-attribute the pending expectation and emit spurious divergence when
// the agent satisfied a later spec. Caller records the full list and matches
// fulfillment against any pattern.
function expectedCommandsFor(memory) {
  if (!memory || !Array.isArray(memory.triggerPretool)) return [];
  return memory.triggerPretool.map(patternFromSpec).filter((p) => p);
}

// Match the matcher's surface: trigger_pretool regexes test the serialized
// tool_input blob, so divergence resolution must compare against the same
// shape — not just `tool_input.command`. Otherwise a pattern that matches the
// JSON form but not the bare command would falsely emit `behavior_changed`
// when the agent ran a compliant follow-up.
function observedFromPayload(payload) {
  const toolInput = (payload && payload.tool_input) || {};
  return JSON.stringify(toolInput);
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
    const observed = observedFromPayload(payload);
    const result = pretoolWindow.resolveExpectation(sessionId, observed);
    if (!result || !result.divergent) return;
    const byName = indexMemoriesByName(memories);
    for (const entry of result.expectations) {
      emitDivergence(entry, byName, payload, observed, sessionId);
    }
  } catch {
    // fail-open
  }
}

module.exports = {
  expectedCommandsFor,
  resolveAndEmitDivergences,
};
