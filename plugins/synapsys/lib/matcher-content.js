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

// Generic, field-agnostic positive content matcher. Scans `patterns` against
// `contentString`, returning the FIRST match as { pattern, substring } or null.
// Invalid regexes are warned-and-skipped (C-5); `label` is the trigger field
// name used only in the warning text (e.g. 'trigger_pretool_content' vs
// 'trigger_posttool_content'), `memoryName` identifies the offending memory.
// Shared by both the pretool and posttool surfaces so the loop body lives once.
function findContentMatchInPatterns(patterns, contentString, { label, memoryName }) {
  if (!Array.isArray(patterns) || patterns.length === 0) return null;
  for (const pat of patterns) {
    let re;
    try {
      re = new RegExp(pat, 'im');
    } catch (err) {
      process.stderr.write(
        `[synapsys] memory ${memoryName}: invalid ${label} regex "${pat}": ${err.message}\n`
      );
      continue;
    }
    const m = re.exec(contentString);
    if (m) return { pattern: pat, substring: m[0] };
  }
  return null;
}

// Generic, field-agnostic AND-NOT content gate. Returns { excluded, pattern }
// where excluded is true on the FIRST pattern that matches `contentString`.
// Invalid regexes are warned-and-skipped (C-5); `label` / `memoryName` shape
// the warning text exactly as findContentMatchInPatterns. Shared by both the
// pretool and posttool negative surfaces.
function evaluateContentNot(patterns, contentString, { label, memoryName }) {
  if (!Array.isArray(patterns) || patterns.length === 0) {
    return { excluded: false, pattern: null };
  }
  for (const pat of patterns) {
    let re;
    try {
      re = new RegExp(pat, 'im');
    } catch (err) {
      process.stderr.write(
        `[synapsys] memory ${memoryName}: invalid ${label} regex "${pat}": ${err.message}\n`
      );
      continue;
    }
    if (re.test(contentString)) {
      return { excluded: true, pattern: pat };
    }
  }
  return { excluded: false, pattern: null };
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
