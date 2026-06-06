'use strict';

const excludes = require('./matcher-excludes');
const content = require('./matcher-content');
const { safeRegex } = require('./matcher-regex');

const extractPretoolContent = content.extractPretoolContent;
const findContentMatch = content.findContentMatch;
const hasNegativeContentPatterns = content.hasNegativeContentPatterns;

/**
 * @typedef {Object} Matched
 * @property {string} [prompt_token]      The matched alternative arm of trigger_prompt.
 * @property {string} [prompt_substring]  The actual substring matched from the user prompt.
 * @property {string} [pretool_pattern]   The trigger_pretool spec entry that matched.
 * @property {string} [content_pattern]   The trigger_pretool_content regex that matched.
 * @property {string} [content_substring] The actual substring matched in the tool input content.
 * @property {string} [negative_pattern]  The trigger_pretool_content_not regex that excluded a match.
 * @property {string} [excluded_pattern]  The exclude_* regex/spec that suppressed an otherwise-positive match.
 */

/**
 * @typedef {Object} MatchResult
 * @property {boolean} fired
 * @property {('events-exclude'|'no-prompt-match'|'no-pretool-match'|'no-content-match'|'negative-excludes'|'exclude-matched'|'no-session-trigger'|'no-stop-response-match'|'expired'|'disabled'|'domain-mismatch')} [reason]
 * @property {Matched} [matched]
 */

/**
 * Resolve the deterministic gate ladder: events-exclude → disabled → expired.
 * Returns the first failing reason, or null if all gates pass.
 *
 * @param {object} memory
 * @param {string} event
 * @returns {string|null}
 */
function gateMemory(memory, event) {
  if (!memory.events.includes(event)) return 'events-exclude';
  if (memory.disabled === true) return 'disabled';
  if (memory.expired === true) return 'expired';
  return null;
}

function makeMatched(fields) {
  const matched = {};
  for (const k of Object.keys(fields)) {
    if (fields[k] !== undefined && fields[k] !== null) matched[k] = fields[k];
  }
  return matched;
}

// Find which top-level alternative arm of trigger_prompt matched. Falls back
// to the full pattern when no individual arm hits (naive split — spec assumes
// human-authored simple alternation).
function _resolvePromptToken(triggerPrompt, prompt) {
  const arms = splitTopLevelAlternation(triggerPrompt);
  for (const arm of arms) {
    const armRe = safeRegex(arm);
    if (armRe && armRe.test(prompt)) return arm;
  }
  return triggerPrompt;
}

function matchPrompt(memory, prompt) {
  const gate = gateMemory(memory, 'UserPromptSubmit');
  if (gate) return { fired: false, reason: gate };
  if (!memory.triggerPrompt) return { fired: false, reason: 'no-prompt-match' };
  const re = safeRegex(memory.triggerPrompt);
  if (!re) return { fired: false, reason: 'no-prompt-match' };
  const promptText = prompt || '';
  const m = re.exec(promptText);
  if (!m) return { fired: false, reason: 'no-prompt-match' };

  // Locked evaluation order (GH-510): trigger → exclude. After a positive
  // trigger_prompt match, evaluate the merged exclude list. Any hit suppresses
  // the fire and returns reason 'exclude-matched' with the offending pattern.
  const excluded = evaluateExcludePrompt(memory, promptText);
  if (excluded.excluded) {
    return {
      fired: false,
      reason: 'exclude-matched',
      matched: makeMatched({ excluded_pattern: excluded.pattern }),
    };
  }

  const prompt_token = _resolvePromptToken(memory.triggerPrompt, promptText);
  return {
    fired: true,
    matched: makeMatched({ prompt_token, prompt_substring: m[0] }),
  };
}

function splitTopLevelAlternation(source) {
  const out = [];
  let depth = 0;
  let buf = '';
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      buf += ch;
      escaped = true;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === '|' && depth === 0) {
      out.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

function parsePretoolSpec(spec) {
  const colon = spec.indexOf(':');
  if (colon === -1) return { tool: spec, pat: '' };
  return {
    tool: spec.slice(0, colon).trim(),
    pat: spec.slice(colon + 1).trim(),
  };
}

function pretoolSpecMatches(spec, toolName, argBlob) {
  const { tool, pat } = parsePretoolSpec(spec);
  if (tool && tool !== '*' && tool !== toolName) return false;
  if (!pat) return true;
  const re = safeRegex(pat);
  return re ? re.test(argBlob) : false;
}

function hasContentPatterns(memory) {
  return Array.isArray(memory.triggerPretoolContent) && memory.triggerPretoolContent.length > 0;
}

// Stage 1: check that the memory wants PreToolUse and the tool/argv prefix
// patterns match. Returns null on miss, or { toolName, toolInput, matchedSpec }
// on hit so callers can proceed to content evaluation.
function _evaluatePreToolPrefix(memory, payload) {
  if (!memory.events.includes('PreToolUse')) return null;
  if (!memory.triggerPretool || !memory.triggerPretool.length) return null;
  const toolName = payload?.tool_name || '';
  const toolInput = payload?.tool_input || {};
  const argBlob = JSON.stringify(toolInput);
  const matchedSpec = memory.triggerPretool.find((spec) =>
    pretoolSpecMatches(spec, toolName, argBlob)
  );
  if (!matchedSpec) return null;
  return { toolName, toolInput, matchedSpec };
}

// Stage 2: given a prefix hit, evaluate positive and negative content
// patterns. Returns one of:
//   { matched: true }
//   { matched: true, hit: { pattern, substring } }
//   { matched: false }
//   { matched: false, negative: { pattern: P } }  // negative-excludes
function _evaluatePreToolContentStage(memory, toolName, toolInput) {
  if (!hasContentPatterns(memory)) return { matched: true };
  const content = extractPretoolContent(toolName, toolInput);
  if (content == null) return { matched: false };
  const hit = findContentMatch(memory, content);
  if (!hit) return { matched: false };
  if (hasNegativeContentPatterns(memory)) {
    const negative = module.exports.evaluatePretoolContentNot(memory, content);
    if (negative.excluded) return { matched: false, negative: { pattern: negative.pattern } };
  }
  return { matched: true, hit };
}

// Shared internal evaluator for matchPreTool / matchPreToolResult. Combines
// the prefix and content stages and carries the matched spec / content hit
// forward for callers that need diagnostics.
function _evaluatePreToolMatch(memory, payload) {
  const prefix = _evaluatePreToolPrefix(memory, payload);
  if (!prefix) return { matched: false };
  const stage = _evaluatePreToolContentStage(memory, prefix.toolName, prefix.toolInput);
  return { ...stage, matchedSpec: prefix.matchedSpec };
}

/**
 * Locked evaluation order for matchPreTool / matchPreToolResult (GH-510):
 *   1. events gate / disabled / expired
 *   2. positive trigger_pretool prefix match (`no-pretool-match` on miss)
 *   3. trigger_pretool_content stage (GH-445): content positive then
 *      `trigger_pretool_content_not` — produces `'negative-excludes'` which
 *      retains priority over `'exclude-matched'`
 *   4. exclude_prompt / exclude_pretool / exclude_preset suppression
 *      (`'exclude-matched'`)
 *
 * The order matters: `'negative-excludes'` is a stage-3 verdict against the
 * tool input content; `'exclude-matched'` is a stage-4 veto against the same
 * inputs the trigger considered. Reordering would silently flip which reason
 * surfaces to memory authors, breaking the explainer contract.
 */
// Stage 4 helper: evaluate exclude_pretool against the pre-tool payload.
// Returns an exclude-matched verdict if any pattern hits, otherwise null.
// Per R4 (brief P0 #4): exclude_prompt is scoped to the user prompt and
// is NOT evaluated against the pretool argBlob — there is no prompt
// string available in the PreToolUse context.
function _evaluatePreToolExcludes(memory, payload) {
  const argBlob = JSON.stringify(payload?.tool_input || {});
  const toolName = payload?.tool_name || '';
  const excluded = evaluateExcludePretool(memory, toolName, argBlob);
  if (excluded.excluded) {
    return makeMatched({ excluded_pattern: excluded.pattern });
  }
  return null;
}

function matchPreTool(memory, payload) {
  const gate = gateMemory(memory, 'PreToolUse');
  if (gate) return { fired: false, reason: gate };
  if (!memory.triggerPretool || !memory.triggerPretool.length) {
    return { fired: false, reason: 'no-pretool-match' };
  }
  const result = _evaluatePreToolMatch(memory, payload);
  if (result.matched) {
    // Stage 4: exclude evaluation runs AFTER positive + content stages so
    // negative-excludes retains priority over exclude-matched (locked order).
    const excludedMatched = _evaluatePreToolExcludes(memory, payload);
    if (excludedMatched) {
      return { fired: false, reason: 'exclude-matched', matched: excludedMatched };
    }
    return {
      fired: true,
      matched: makeMatched({
        pretool_pattern: result.matchedSpec,
        content_pattern: result.hit?.pattern,
        content_substring: result.hit?.substring,
      }),
    };
  }
  if (!result.matchedSpec) return { fired: false, reason: 'no-pretool-match' };
  if (result.negative) {
    return {
      fired: false,
      reason: 'negative-excludes',
      matched: makeMatched({
        pretool_pattern: result.matchedSpec,
        negative_pattern: result.negative.pattern,
      }),
    };
  }
  return { fired: false, reason: 'no-content-match' };
}

// Content helpers (extract*, evaluate*Content*, findContentMatch) live in
// matcher-content.js and are re-bound at the top of this file so the public
// matcher API stays stable for memory-store.js and the explainer CLI.

// Stage-4 exclude evaluators are implemented in matcher-excludes.js. These
// thin wrappers bind matcher.js's pretool spec helpers so call-sites here
// stay parameter-free and the public API surface is unchanged.
const hasExcludePatterns = excludes.hasExcludePatterns;
const evaluateExcludePrompt = excludes.evaluateExcludePrompt;
function evaluateExcludePretool(memory, toolName, argBlob) {
  return excludes.evaluateExcludePretool(memory, toolName, argBlob, {
    parsePretoolSpec,
    pretoolSpecMatches,
  });
}

// matchPreToolResult — object-mode wrapper around matchPreTool.
//
// Locked decision (GH-445 brief P0 #8 / spec §Architecture Decisions):
//   On negative-exclude: { matched: false, reason: 'negative-excludes',
//                          matched: { negative_pattern: P } }
// In JS the later `matched` key wins, so the observable shape is
//   { reason: 'negative-excludes', matched: { negative_pattern: P } }.
// On positive match:   { matched: true }
// On positive miss:    { matched: false }
//
// Broader MatchResult contract (other reasons, explainer CLI) is GH-443's domain;
// this wrapper exposes only the negative-excludes signal.
function matchPreToolResult(memory, payload) {
  if (gateMemory(memory, 'PreToolUse')) return { matched: false };
  const result = _evaluatePreToolMatch(memory, payload);
  if (result.matched) {
    // Stage 4: exclude evaluation — same locked order as matchPreTool.
    const argBlob = JSON.stringify(payload?.tool_input || {});
    const toolName = payload?.tool_name || '';
    const excluded = evaluateExcludePretool(memory, toolName, argBlob);
    if (excluded.excluded) {
      return {
        reason: 'exclude-matched',
        matched: { excluded_pattern: excluded.pattern },
      };
    }
    return { matched: true };
  }
  if (result.negative) {
    return {
      reason: 'negative-excludes',
      matched: { negative_pattern: result.negative.pattern },
    };
  }
  return { matched: false };
}

function matchSession(memory) {
  const gate = gateMemory(memory, 'SessionStart');
  if (gate) return { fired: false, reason: gate };
  if (memory.triggerSession !== true) return { fired: false, reason: 'no-session-trigger' };
  return { fired: true };
}

const stopMatcher = require('./matcher-stop');

function matchStop(memory, payload) {
  return stopMatcher.matchStop(memory, payload, { gateMemory, safeRegex, makeMatched });
}

const _extractStopResponse = stopMatcher._extractStopResponse;

/**
 * Domain gate (GH-513 R4 / AC2): when `memory.domain` is non-empty AND an
 * `activeDomains` set is supplied AND their intersection is empty, the memory
 * is excluded BEFORE trigger evaluation. Returns true when the memory should
 * be skipped with reason `domain-mismatch`.
 *
 * Fail-open semantics:
 *   - memory.domain empty/missing  -> not gated (backward compat R10/AC1)
 *   - activeDomains undefined/null -> not gated (backward compat R10)
 *
 * @param {object} memory
 * @param {Set<string>|undefined} activeDomains
 * @returns {boolean}
 */
function isDomainMismatch(memory, activeDomains) {
  if (!activeDomains) return false;
  const domains = memory && memory.domain;
  if (!Array.isArray(domains) || domains.length === 0) return false;
  for (const d of domains) {
    if (activeDomains.has(d)) return false;
  }
  return true;
}

/**
 * Select memories that fire for the given event payload.
 * Reads `.fired` from each per-memory `MatchResult`.
 *
 * @param {Array<object>} memories
 * @param {string} event
 * @param {object} payload
 * @param {{ activeDomains?: Set<string> }} [opts]
 * @returns {Array<object>} subset of `memories` whose matcher fired.
 */
const EVENT_MATCHERS = {
  UserPromptSubmit: (m, payload) => matchPrompt(m, payload?.prompt || ''),
  PreToolUse: (m, payload) => matchPreTool(m, payload),
  SessionStart: (m) => matchSession(m),
  Stop: (m, payload) => matchStop(m, payload),
};

function selectForEvent(memories, event, payload, opts) {
  const activeDomains = opts && opts.activeDomains;
  const matcher = EVENT_MATCHERS[event];
  const matched = [];
  for (const m of memories) {
    if (isDomainMismatch(m, activeDomains)) continue;
    const result = matcher ? matcher(m, payload) : { fired: false };
    if (result.fired) matched.push(m);
  }
  return matched;
}

module.exports = {
  selectForEvent,
  matchPrompt,
  matchPreTool,
  matchPreToolResult,
  matchSession,
  matchStop,
  _extractStopResponse,
  safeRegex,
  splitTopLevelAlternation,
  extractPretoolContent,
  evaluatePretoolContent: content.evaluatePretoolContent,
  evaluatePretoolContentNot: content.evaluatePretoolContentNot,
  hasNegativeContentPatterns,
  isDomainMismatch,
  evaluateExcludePrompt,
  evaluateExcludePretool,
  hasExcludePatterns,
};
