'use strict';

/**
 * Pure-regex domain classifier for synapsys (GH-513 Task 4).
 *
 * `classifyActiveDomains({ prompt, recentToolCalls, registry })` returns a
 * `Set<string>` of active domain tags.
 *
 * Contract:
 *   - For every leaf whose `signal_prompt` matches `prompt` OR whose
 *     `signal_pretool` matches any string in `recentToolCalls`, both the
 *     parent root (`<root>`) and the qualified leaf (`<root>:<leaf>`) are
 *     emitted into the active set. This implements the inheritance rule:
 *     a memory tagged `domain: <root>` fires whenever any of its leaves is
 *     active.
 *   - Multi-leaf-in-same-root produces one root entry + multiple leaf entries
 *     (Set de-dupes the root).
 *   - Cross-root matches union (OR semantics across roots).
 *
 * Performance budget: <5ms p99 on registries up to ~50 leaves, with prompts
 * up to a few KB. Implementation is a single pass over `registry.roots`
 * executing pre-compiled `RegExp` objects (no allocation per match), so the
 * dominant cost is the regex engine itself, well inside budget.
 *
 * Pure: no I/O, no LLM, no async, no clock. Caller supplies all inputs.
 *
 * Defensive: undefined/null prompt → treated as empty string; missing or
 * non-array `recentToolCalls` → treated as `[]`; empty/missing registry →
 * empty `Set`.
 *
 * @param {object} args
 * @param {string|null|undefined} args.prompt
 * @param {string[]|null|undefined} args.recentToolCalls
 * @param {{ roots: Map<string, { leaves: Map<string, { signal_prompt: RegExp[], signal_pretool: RegExp[] }> }> }} args.registry
 * @returns {Set<string>}
 */
function classifyActiveDomains({ prompt, recentToolCalls, registry } = {}) {
  const active = new Set();
  if (!registry || !registry.roots || typeof registry.roots.forEach !== 'function') {
    return active;
  }

  const promptStr = typeof prompt === 'string' ? prompt : '';
  const tools = Array.isArray(recentToolCalls) ? recentToolCalls : [];

  for (const { rootName, leafName, leaf } of iterateLeafSignals(registry)) {
    if (matchesAny(leaf.signal_prompt, promptStr) || matchesAnyTool(leaf.signal_pretool, tools)) {
      active.add(rootName);
      active.add(`${rootName}:${leafName}`);
    }
  }

  return active;
}

/**
 * Generator yielding `{ rootName, leafName, leaf }` for every leaf in the
 * registry. Inlined here for clarity; the REFACTOR phase formalizes the name.
 */
function* iterateLeafSignals(registry) {
  for (const [rootName, root] of registry.roots) {
    if (!root || !root.leaves) continue;
    for (const [leafName, leaf] of root.leaves) {
      if (!leaf) continue;
      yield { rootName, leafName, leaf };
    }
  }
}

function matchesAny(patterns, text) {
  if (!Array.isArray(patterns) || patterns.length === 0 || !text) return false;
  for (const re of patterns) {
    if (re && typeof re.test === 'function' && re.test(text)) return true;
  }
  return false;
}

function matchesAnyTool(patterns, tools) {
  if (!Array.isArray(patterns) || patterns.length === 0 || tools.length === 0) return false;
  for (const tool of tools) {
    if (typeof tool === 'string' && tool.length > 0 && matchesAny(patterns, tool)) return true;
  }
  return false;
}

/**
 * Compose pure-regex classification with sticky-domain hysteresis (GH-513 Task 6).
 *
 * Returns `{ activeDomains, nextStickyState }` where:
 *   - `activeDomains` = raw classifier output ∪ sticky-active domains for `sessionId`.
 *   - `nextStickyState` is the updated sticky-state object (caller persists it).
 *
 * AC5: after 3 consecutive raw-active prompts a domain becomes sticky and
 * survives 1 subsequent quiet prompt.
 * AC6: after 3 consecutive quiet prompts the sticky entry is dropped.
 *
 * Pure: relies only on caller-supplied `now`. Does not touch `classifyActiveDomains`.
 *
 * @param {object} args
 * @param {string|null|undefined} args.prompt
 * @param {string[]|null|undefined} args.recentToolCalls
 * @param {object} args.registry
 * @param {object} args.stickyState
 * @param {string} args.sessionId
 * @param {number} [args.now]
 * @returns {{ activeDomains: Set<string>, nextStickyState: object }}
 */
function classifyWithSticky({
  prompt,
  recentToolCalls,
  registry,
  stickyState,
  sessionId,
  now = Date.now(),
} = {}) {
  const { updateStickyState } = require('./sticky-state');

  const rawActive = classifyActiveDomains({ prompt, recentToolCalls, registry });
  const nextStickyState = updateStickyState({
    state: stickyState,
    sessionId,
    rawActiveSet: rawActive,
    now,
  });

  const activeDomains = new Set(rawActive);
  const session = (nextStickyState && nextStickyState[sessionId]) || {};
  for (const domain of Object.keys(session)) {
    const entry = session[domain];
    if (entry && entry.sticky === true) {
      activeDomains.add(domain);
    }
  }

  return { activeDomains, nextStickyState };
}

module.exports = { classifyActiveDomains, classifyWithSticky, iterateLeafSignals };
