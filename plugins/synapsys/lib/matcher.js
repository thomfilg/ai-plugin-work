'use strict';

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
 * @property {('events-exclude'|'no-prompt-match'|'no-pretool-match'|'no-content-match'|'negative-excludes'|'exclude-matched'|'no-session-trigger'|'expired'|'disabled'|'domain-mismatch')} [reason]
 * @property {Matched} [matched]
 */

function safeRegex(pattern, flags = 'i') {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

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

function matchPrompt(memory, prompt) {
  const gate = gateMemory(memory, 'UserPromptSubmit');
  if (gate) return { fired: false, reason: gate };
  if (!memory.triggerPrompt) return { fired: false, reason: 'no-prompt-match' };
  const re = safeRegex(memory.triggerPrompt);
  if (!re) return { fired: false, reason: 'no-prompt-match' };
  const m = re.exec(prompt || '');
  if (!m) return { fired: false, reason: 'no-prompt-match' };

  // Determine which top-level alternative arm matched. Split memory.triggerPrompt
  // by top-level `|` (naive, but trigger_prompt regex is human-authored simple
  // alternation per the spec). Pick the first arm whose own regex matches.
  const arms = splitTopLevelAlternation(memory.triggerPrompt);
  let prompt_token = memory.triggerPrompt;
  for (const arm of arms) {
    const armRe = safeRegex(arm);
    if (armRe && armRe.test(prompt || '')) {
      prompt_token = arm;
      break;
    }
  }

  // Locked evaluation order (GH-510): trigger → exclude. After a positive
  // trigger_prompt match, evaluate the merged exclude list. Any hit suppresses
  // the fire and returns reason 'exclude-matched' with the offending pattern.
  const excluded = evaluateExcludePrompt(memory, prompt || '');
  if (excluded.excluded) {
    return {
      fired: false,
      reason: 'exclude-matched',
      matched: makeMatched({ excluded_pattern: excluded.pattern }),
    };
  }

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
    const argBlob = JSON.stringify(payload?.tool_input || {});
    const toolName = payload?.tool_name || '';
    const excluded = evaluateExcludePretool(memory, toolName, argBlob);
    if (excluded.excluded) {
      return {
        fired: false,
        reason: 'exclude-matched',
        matched: makeMatched({ excluded_pattern: excluded.pattern }),
      };
    }
    // Also evaluate exclude_prompt against the argBlob to honor R11 OR
    // composition — exclude_prompt patterns apply to any input the trigger
    // saw (matching the prompt-side semantics consistently).
    const excludedByPrompt = evaluateExcludePrompt(memory, argBlob);
    if (excludedByPrompt.excluded) {
      return {
        fired: false,
        reason: 'exclude-matched',
        matched: makeMatched({ excluded_pattern: excludedByPrompt.pattern }),
      };
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

function extractMultiEditContent(edits) {
  if (!Array.isArray(edits)) return null;
  const strings = edits
    .map((e) => (e && typeof e.new_string === 'string' ? e.new_string : null))
    .filter((s) => s !== null);
  if (strings.length === 0) return null;
  return strings.join('\n');
}

const PRETOOL_CONTENT_EXTRACTORS = {
  Edit: (i) => (typeof i.new_string === 'string' ? i.new_string : null),
  Write: (i) => (typeof i.content === 'string' ? i.content : null),
  MultiEdit: (i) => extractMultiEditContent(i.edits),
  NotebookEdit: (i) => (typeof i.new_source === 'string' ? i.new_source : null),
};

function extractPretoolContent(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const extractor = PRETOOL_CONTENT_EXTRACTORS[toolName];
  return extractor ? extractor(toolInput) : null;
}

function evaluatePretoolContent(memory, contentString) {
  return findContentMatch(memory, contentString) !== null;
}

function findContentMatch(memory, contentString) {
  const patterns = memory.triggerPretoolContent;
  if (!Array.isArray(patterns) || patterns.length === 0) return null;
  let hit = null;
  for (const pat of patterns) {
    let re;
    try {
      re = new RegExp(pat, 'im');
    } catch (err) {
      process.stderr.write(
        `[synapsys] memory ${memory.name}: invalid trigger_pretool_content regex "${pat}": ${err.message}\n`
      );
      continue;
    }
    const m = re.exec(contentString);
    if (m && hit === null) {
      hit = { pattern: pat, substring: m[0] };
    }
  }
  return hit;
}

function hasNegativeContentPatterns(memory) {
  return (
    Array.isArray(memory.triggerPretoolContentNot) && memory.triggerPretoolContentNot.length > 0
  );
}

function evaluatePretoolContentNot(memory, contentString) {
  const patterns = memory.triggerPretoolContentNot;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return { excluded: false, pattern: null };
  }
  for (const pat of patterns) {
    let re;
    try {
      re = new RegExp(pat, 'im');
    } catch (err) {
      process.stderr.write(
        `[synapsys] memory ${memory.name}: invalid trigger_pretool_content_not regex "${pat}": ${err.message}\n`
      );
      continue;
    }
    if (re.test(contentString)) {
      return { excluded: true, pattern: pat };
    }
  }
  return { excluded: false, pattern: null };
}

/**
 * True iff the memory carries any resolved exclude pattern (either inline
 * `exclude_prompt` / `exclude_preset` flattened into `excludeResolved`, or
 * any `exclude_pretool` spec).
 *
 * @param {object} memory
 * @returns {boolean}
 */
function hasExcludePatterns(memory) {
  const resolved = Array.isArray(memory.excludeResolved) && memory.excludeResolved.length > 0;
  const pretool = Array.isArray(memory.excludePretool) && memory.excludePretool.length > 0;
  return resolved || pretool;
}

/**
 * Evaluate the resolved exclude list (inline `exclude_prompt` + flattened
 * `exclude_preset` bodies, in `memory.excludeResolved`) against an input
 * string (typically a user prompt or a stringified tool_input blob).
 * Invalid regex entries are skipped with a stderr warning so a single bad
 * pattern cannot abort the matcher (fail-closed / R15).
 *
 * @param {object} memory
 * @param {string} input
 * @returns {{ excluded: boolean, pattern: string|null }}
 */
function evaluateExcludePrompt(memory, input) {
  const patterns = memory.excludeResolved;
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return { excluded: false, pattern: null };
  }
  const text = input || '';
  // Two-pass evaluation:
  //   pass 1 — compile every pattern, emit stderr warnings for invalid ones
  //            so memory authors are told about all bad regex even when an
  //            earlier valid one matches (fail-closed / R15).
  //   pass 2 — return on the first valid regex that matches.
  const compiled = [];
  for (const pat of patterns) {
    const re = safeRegex(pat);
    if (!re) {
      process.stderr.write(
        `[synapsys] memory ${memory.name}: invalid exclude regex "${pat}"\n`
      );
      continue;
    }
    compiled.push({ pat, re });
  }
  for (const { pat, re } of compiled) {
    if (re.test(text)) return { excluded: true, pattern: pat };
  }
  return { excluded: false, pattern: null };
}

/**
 * Evaluate `memory.excludePretool` (array of `tool:pattern` specs sharing the
 * shape of `trigger_pretool`) against a candidate (toolName, argBlob). Reuses
 * `parsePretoolSpec` / `pretoolSpecMatches` so the spec grammar stays in one
 * place. Invalid regex inside a spec is fail-closed (no exclude fires).
 *
 * @param {object} memory
 * @param {string} toolName
 * @param {string} argBlob
 * @returns {{ excluded: boolean, pattern: string|null }}
 */
function evaluateExcludePretool(memory, toolName, argBlob) {
  const specs = memory.excludePretool;
  if (!Array.isArray(specs) || specs.length === 0) {
    return { excluded: false, pattern: null };
  }
  for (const spec of specs) {
    try {
      if (pretoolSpecMatches(spec, toolName, argBlob || '')) {
        return { excluded: true, pattern: spec };
      }
    } catch (err) {
      process.stderr.write(
        `[synapsys] memory ${memory.name}: invalid exclude_pretool spec "${spec}": ${err.message}\n`
      );
    }
  }
  return { excluded: false, pattern: null };
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
    const excludedByPrompt = evaluateExcludePrompt(memory, argBlob);
    if (excludedByPrompt.excluded) {
      return {
        reason: 'exclude-matched',
        matched: { excluded_pattern: excludedByPrompt.pattern },
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

// Stop event fires at the assistant's turn end. The classifier matrix assigns
// Stop to memories that are retrospective checks ("did I run follow-up-pr?",
// "cleanup the tmp file"). They fire unconditionally for any memory listing
// Stop in events — the body itself IS the reminder, no separate trigger.
function matchStop(memory) {
  const gate = gateMemory(memory, 'Stop');
  if (gate) return { fired: false, reason: gate };
  return { fired: true };
}

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
  Stop: (m) => matchStop(m),
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
  safeRegex,
  splitTopLevelAlternation,
  extractPretoolContent,
  evaluatePretoolContent,
  evaluatePretoolContentNot,
  hasNegativeContentPatterns,
  isDomainMismatch,
  evaluateExcludePrompt,
  evaluateExcludePretool,
  hasExcludePatterns,
};
