'use strict';

/**
 * Suggestion generation (R8).
 *
 * Split out of `scripts/synapsys-lint.js` (GH-534) to keep `generateSuggestion`
 * under the complexity cap. Each rule has its own helper.
 */

const { extractAlternationTokens } = require('../shared/trigger-tokens');

/**
 * pickPairMemories — locate the two memory records matching pair.a / pair.b.
 * Either may be null if not found — suggestion generation degrades gracefully.
 */
function pickPairMemories(memories, pair) {
  const byName = new Map(memories.map((m) => [m.name, m]));
  return { aMem: byName.get(pair.a) || null, bMem: byName.get(pair.b) || null };
}

/**
 * Suggestion for `trigger-body-overlap` pairs (Task 5).
 */
function suggestBodyOverlap(pair) {
  const matched = Array.isArray(pair.matchedTokens) ? pair.matchedTokens : [];
  const token = matched[0];
  if (token) {
    return `Tighten ${pair.b}.trigger_prompt to exclude the literal token \`${token}\` (matched ${pair.score}× in ${pair.a}'s body), or move the body reference into a [[${pair.b}]] link.`;
  }
  return `Tighten ${pair.b}.trigger_prompt — its tokens appear ${pair.score}× inside ${pair.a}'s body.`;
}

/**
 * Build aTokens/bTokens/aOnly/bOnly/shared bags for a trigger-overlap pair.
 */
function triggerTokenBags(pair, aMem, bMem) {
  const aTokens = aMem ? new Set(extractAlternationTokens(aMem.triggerPrompt || '')) : new Set();
  const bTokens = bMem ? new Set(extractAlternationTokens(bMem.triggerPrompt || '')) : new Set();
  const aOnly = [...aTokens].filter((t) => !bTokens.has(t));
  const bOnly = [...bTokens].filter((t) => !aTokens.has(t));
  const shared = [...aTokens].filter((t) => bTokens.has(t));
  return { aOnly, bOnly, shared };
}

/**
 * Suggestion for `trigger-overlap` pairs (Task 4).
 */
function suggestTriggerOverlap(pair, aMem, bMem) {
  const { aOnly, bOnly, shared } = triggerTokenBags(pair, aMem, bMem);
  if (aOnly.length > 0 && bOnly.length === 0 && shared.length > 0) {
    return `Remove the token \`${shared[0]}\` from ${pair.a}.trigger_prompt to disambiguate it from ${pair.b}.`;
  }
  if (bOnly.length > 0 && aOnly.length === 0 && shared.length > 0) {
    return `Remove the token \`${shared[0]}\` from ${pair.b}.trigger_prompt to disambiguate it from ${pair.a}.`;
  }
  if (shared.length > 0) {
    const distinctive = aOnly[0] || bOnly[0] || shared[0];
    return `Trigger sets share \`${shared[0]}\` — tighten ${pair.a} or ${pair.b} by anchoring on \`${distinctive}\` (or removing the shared token).`;
  }
  return `Reduce overlap between ${pair.a} and ${pair.b}.trigger_prompt.`;
}

/**
 * Pull the first arg-source string for `tool` from a `trigger_pretool` list.
 * Supports both `{tool, arg}` records and `"tool:arg"` legacy strings.
 */
function firstArgFor(list, tool) {
  for (const ent of list) {
    if (ent && ent.tool === tool && typeof ent.arg === 'string') return ent.arg;
    if (typeof ent === 'string' && ent.startsWith(`${tool}:`)) return ent.slice(tool.length + 1);
  }
  return null;
}

/**
 * Suggestion for `pretool-overlap` pairs (Task 6).
 */
function suggestPretoolOverlap(pair, aMem, bMem) {
  const aPretool = (aMem && aMem.triggerPretool) || [];
  const bPretool = (bMem && bMem.triggerPretool) || [];
  const sample = firstArgFor(aPretool, pair.tool) || firstArgFor(bPretool, pair.tool);
  if (sample) {
    return `Narrow ${pair.a} or ${pair.b}.trigger_pretool[${pair.tool}] — their arg-patterns overlap on \`${sample}\`.`;
  }
  return `Narrow ${pair.a} or ${pair.b}.trigger_pretool[${pair.tool}] to avoid overlap.`;
}

/**
 * generateSuggestion — R8: produce a non-empty advice string that references
 * a literal token from one of the pair's memories. Dispatches by `pair.rule`
 * to a small set of rule-specific helpers.
 */
function generateSuggestion(pair, memories) {
  const { aMem, bMem } = pickPairMemories(memories, pair);
  if (pair.rule === 'trigger-body-overlap') return suggestBodyOverlap(pair);
  if (pair.rule === 'trigger-overlap') return suggestTriggerOverlap(pair, aMem, bMem);
  if (pair.rule === 'pretool-overlap') return suggestPretoolOverlap(pair, aMem, bMem);
  return `Reduce overlap between ${pair.a} and ${pair.b}.`;
}

module.exports = { generateSuggestion };
