'use strict';

/**
 * Pretool content extraction and `trigger_pretool_content` /
 * `trigger_pretool_content_not` evaluators. Split out of matcher.js so the
 * stage-3 helpers live alongside their data shape and the main matcher file
 * stays under the quality gate's max-lines budget.
 */

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

// Single shared regex-scan engine for BOTH the positive ('find') and AND-NOT
// ('not') content surfaces, so the Array-guard → for-loop → new RegExp →
// warn-and-skip → match/test body lives in exactly ONE place (jscpd clone
// removal). `label` is the trigger field name used only in the warning text
// (e.g. 'trigger_pretool_content'); `memoryName` identifies the offending
// memory; `mode` selects the return shape:
//   'find' → returns { pattern, substring } on the first match, else null
//   'not'  → returns { excluded: true, pattern } on the first match,
//            else { excluded: false, pattern: null }
// Invalid regexes are warned-and-skipped (C-5). Every pattern in the list is
// compiled/validated even after an earlier one already matched — an early
// return would silence the invalid-regex warning for later patterns, leaving
// the author with no signal that a pattern is broken. The FIRST hit still
// wins; validation of the remainder has no effect on the result.
// Compile one pattern with the standard warn-and-skip diagnostics. Returns the
// RegExp, or null on an invalid pattern (after writing the stderr warning).
function _compilePattern(pat, label, memoryName) {
  try {
    return new RegExp(pat, 'im');
  } catch (err) {
    process.stderr.write(
      `[synapsys] memory ${memoryName}: invalid ${label} regex "${pat}": ${err.message}\n`
    );
    return null;
  }
}

// Evaluate one compiled pattern in the given mode. Returns the mode's hit
// shape, or null on a miss.
function _matchPattern(re, pat, contentString, mode) {
  if (mode === 'not') {
    return re.test(contentString) ? { excluded: true, pattern: pat } : null;
  }
  const m = re.exec(contentString);
  return m ? { pattern: pat, substring: m[0] } : null;
}

function _scanPatterns(patterns, contentString, { label, memoryName, mode }) {
  const miss = mode === 'not' ? { excluded: false, pattern: null } : null;
  if (!Array.isArray(patterns) || patterns.length === 0) return miss;
  let hit = null;
  for (const pat of patterns) {
    const re = _compilePattern(pat, label, memoryName);
    // Already matched — later patterns are still compiled (for warnings) but
    // not evaluated; the FIRST hit wins.
    if (!re || hit) continue;
    hit = _matchPattern(re, pat, contentString, mode);
  }
  return hit || miss;
}

// Generic, field-agnostic positive content matcher. Scans `patterns` against
// `contentString`, returning the FIRST match as { pattern, substring } or null.
// Thin wrapper over _scanPatterns (mode 'find'). Shared by both the pretool and
// posttool surfaces.
function findContentMatchInPatterns(patterns, contentString, { label, memoryName }) {
  return _scanPatterns(patterns, contentString, { label, memoryName, mode: 'find' });
}

// Generic, field-agnostic AND-NOT content gate. Returns { excluded, pattern }
// where excluded is true on the FIRST pattern that matches `contentString`.
// Thin wrapper over _scanPatterns (mode 'not'). Shared by both the pretool and
// posttool negative surfaces.
function evaluateContentNot(patterns, contentString, { label, memoryName }) {
  return _scanPatterns(patterns, contentString, { label, memoryName, mode: 'not' });
}

function findContentMatch(memory, contentString) {
  return findContentMatchInPatterns(memory.triggerPretoolContent, contentString, {
    label: 'trigger_pretool_content',
    memoryName: memory.name,
  });
}

function evaluatePretoolContent(memory, contentString) {
  return findContentMatch(memory, contentString) !== null;
}

function hasNegativeContentPatterns(memory) {
  return (
    Array.isArray(memory.triggerPretoolContentNot) && memory.triggerPretoolContentNot.length > 0
  );
}

function evaluatePretoolContentNot(memory, contentString) {
  return evaluateContentNot(memory.triggerPretoolContentNot, contentString, {
    label: 'trigger_pretool_content_not',
    memoryName: memory.name,
  });
}

module.exports = {
  extractMultiEditContent,
  extractPretoolContent,
  evaluatePretoolContent,
  findContentMatch,
  hasNegativeContentPatterns,
  evaluatePretoolContentNot,
  // Generic, field-agnostic helpers shared with matcher-posttool.js so the
  // regex-list loop bodies live in exactly one place (jscpd clone removal).
  findContentMatchInPatterns,
  evaluateContentNot,
};
