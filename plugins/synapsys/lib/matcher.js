'use strict';

function safeRegex(pattern, flags = 'i') {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function matchPrompt(memory, prompt) {
  if (!memory.events.includes('UserPromptSubmit')) return false;
  if (!memory.triggerPrompt) return false;
  const re = safeRegex(memory.triggerPrompt);
  if (!re) return false;
  return re.test(prompt || '');
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
// patterns match. Returns null on miss, or the resolved { toolName, toolInput }
// on hit so callers can proceed to content evaluation.
function _evaluatePreToolPrefix(memory, payload) {
  if (!memory.events.includes('PreToolUse')) return null;
  if (!memory.triggerPretool.length) return null;
  const toolName = payload?.tool_name || '';
  const toolInput = payload?.tool_input || {};
  const argBlob = JSON.stringify(toolInput);
  const prefixMatch = memory.triggerPretool.some((spec) =>
    pretoolSpecMatches(spec, toolName, argBlob)
  );
  if (!prefixMatch) return null;
  return { toolName, toolInput };
}

// Stage 2: given a prefix hit, evaluate positive and negative content
// patterns. Returns the shared match result.
function _evaluatePreToolContentStage(memory, toolName, toolInput) {
  if (!hasContentPatterns(memory)) return { matched: true };
  const content = extractPretoolContent(toolName, toolInput);
  if (content == null) return { matched: false };
  if (!evaluatePretoolContent(memory, content)) return { matched: false };
  if (!hasNegativeContentPatterns(memory)) return { matched: true };
  const negative = module.exports.evaluatePretoolContentNot(memory, content);
  if (negative.excluded) return { matched: false, negative: { pattern: negative.pattern } };
  return { matched: true };
}

// Shared internal evaluator for matchPreTool / matchPreToolResult.
// Returns one of:
//   { matched: true }
//   { matched: false }
//   { matched: false, negative: { pattern: P } }  // negative-excludes
function _evaluatePreToolMatch(memory, payload) {
  const prefix = _evaluatePreToolPrefix(memory, payload);
  if (!prefix) return { matched: false };
  return _evaluatePreToolContentStage(memory, prefix.toolName, prefix.toolInput);
}

function matchPreTool(memory, payload) {
  return _evaluatePreToolMatch(memory, payload).matched;
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
  const patterns = memory.triggerPretoolContent;
  if (!Array.isArray(patterns) || patterns.length === 0) return false;
  let matched = false;
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
    if (re.test(contentString)) matched = true;
  }
  return matched;
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
  const result = _evaluatePreToolMatch(memory, payload);
  if (result.matched) return { matched: true };
  if (result.negative) {
    return {
      reason: 'negative-excludes',
      matched: { negative_pattern: result.negative.pattern },
    };
  }
  return { matched: false };
}

function matchSession(memory) {
  if (!memory.events.includes('SessionStart')) return false;
  return memory.triggerSession === true;
}

// Stop event fires at the assistant's turn end. The classifier matrix assigns
// Stop to memories that are retrospective checks ("did I run follow-up-pr?",
// "cleanup the tmp file"). They fire unconditionally for any memory listing
// Stop in events — the body itself IS the reminder, no separate trigger.
function matchStop(memory) {
  return memory.events.includes('Stop');
}

function selectForEvent(memories, event, payload) {
  const matched = [];
  for (const m of memories) {
    let hit = false;
    if (event === 'UserPromptSubmit') hit = matchPrompt(m, payload?.prompt || '');
    else if (event === 'PreToolUse') hit = matchPreTool(m, payload);
    else if (event === 'SessionStart') hit = matchSession(m);
    else if (event === 'Stop') hit = matchStop(m);
    if (hit) matched.push(m);
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
  extractPretoolContent,
  evaluatePretoolContent,
  evaluatePretoolContentNot,
  hasNegativeContentPatterns,
};
