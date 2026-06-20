'use strict';

/**
 * Subagent prompt-scope match propagation (GH-497 R3/R6).
 *
 * Extracted from the dispatcher hook (synapsys.js) to keep that file under the
 * 400-line cap after merging onto current main. `computeMatched` is the single
 * entry point; the rest are module-internal helpers.
 *
 * Strictly fail-open: any matcher/classifier throw is swallowed per-call so a
 * subagent spawn (or any PreToolUse) is never blocked.
 */

const path = require('node:path');
const { selectForEvent } = require(path.join(__dirname, '..', '..', 'lib', 'matcher'));
const { buildActiveDomains } = require(path.join(__dirname, '..', '..', 'lib', 'active-domains'));
const injectLedger = require('../../lib/inject-ledger');

// collectSubagentMatches — GH-497 R3/R6. When a PreToolUse payload spawns a
// subagent (`tool_name` is 'Task' or 'Agent') carrying a string
// `tool_input.prompt`, run the prompt-scope matchers (UserPromptSubmit plus
// SessionStart per P1 R6 — startup/prompt scope) against a synthetic prompt
// payload so the subagent inherits those memories in its initial context.
// `Stop` is intentionally excluded: it is end-of-turn retrospective and
// semantically wrong at spawn time, and Stop memories without a
// `trigger_stop_response` fire unconditionally — including them here would
// inject end-of-turn policies into unrelated subagent spawns (PR #605, Cursor
// "Stop matcher spurious subagent injection"; see tasks/GH-497/decisions.md).
const SUBAGENT_TOOLS = new Set(['Task', 'Agent']);
const SUBAGENT_PROMPT_EVENTS = ['UserPromptSubmit', 'SessionStart'];

// Recompute activeDomains from the synthetic prompt payload rather than reusing
// the outer PreToolUse selectOpts, whose activeDomains reflect the parent
// payload (often an empty `prompt`) and would wrongly skip/allow domain-tagged
// memories (PR #605, Cursor "Wrong domains for subagent prompts"). Read-only:
// onPersistSticky is a no-op so a subagent spawn never advances the parent
// session's sticky-domain run. Fail-open: any classifier throw → undefined opts.
function buildSubagentSelectOpts(synthetic) {
  try {
    const activeDomains = buildActiveDomains('UserPromptSubmit', synthetic, {
      resolveSessionId: injectLedger.resolveSessionId,
      onPersistSticky: () => {},
    });
    return activeDomains ? { activeDomains } : undefined;
  } catch {
    return undefined;
  }
}

function collectSubagentMatches(payload, memories) {
  const toolName = payload && payload.tool_name;
  const promptText = payload && payload.tool_input && payload.tool_input.prompt;
  if (!SUBAGENT_TOOLS.has(toolName) || typeof promptText !== 'string') return [];
  const synthetic = { ...payload, prompt: promptText };
  const subagentOpts = buildSubagentSelectOpts(synthetic);
  const collected = [];
  for (const ev of SUBAGENT_PROMPT_EVENTS) {
    try {
      const hits = selectForEvent(memories, ev, synthetic, subagentOpts);
      if (Array.isArray(hits)) collected.push(...hits);
    } catch {
      /* fail-open: a matcher throw never blocks the subagent spawn */
    }
  }
  return collected;
}

// unionByName — append `extra` matches onto `primary`, skipping any whose
// `memory.name` already appears in `primary` (dedupe-by-name; GH-497 R3 G5).
function unionByName(primary, extra) {
  const seen = new Set(primary.map((m) => m.name));
  const merged = primary.slice();
  for (const m of extra) {
    if (seen.has(m.name)) continue;
    seen.add(m.name);
    merged.push(m);
  }
  return merged;
}

// GH-497 R3/R6: on a PreToolUse subagent spawn (Task/Agent), union the
// prompt-scope matches (deduped by name) so a memory matching both injects once.
// Returns `{ matched, subagentNames }` where `subagentNames` is the set of names
// that entered `matched` ONLY via the subagent prompt path (not a genuine
// PreToolUse tool match). Downstream render/emit treat those specially: they are
// rendered full (the subagent is a fresh context — PR #605 "Subagent context
// uses reminder ledger") and excluded from pretool-expectation recording (they
// matched the synthetic prompt, not the tool — PR #605 "Pretool expectations on
// prompt-only matches").
function computeMatched(event, memories, payload, selectOpts) {
  let matched = memories.length ? selectForEvent(memories, event, payload, selectOpts) : [];
  const subagentNames = new Set();
  if (event === 'PreToolUse' && memories.length) {
    const subagentMatches = collectSubagentMatches(payload, memories);
    if (subagentMatches.length) {
      const beforeNames = new Set(matched.map((m) => m.name));
      matched = unionByName(matched, subagentMatches);
      for (const m of subagentMatches) {
        if (!beforeNames.has(m.name)) subagentNames.add(m.name);
      }
    }
  }
  return { matched, subagentNames };
}

module.exports = { computeMatched };
