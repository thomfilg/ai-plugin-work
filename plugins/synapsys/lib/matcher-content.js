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

function evaluatePretoolContent(memory, contentString) {
  return findContentMatch(memory, contentString) !== null;
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

module.exports = {
  extractMultiEditContent,
  extractPretoolContent,
  evaluatePretoolContent,
  findContentMatch,
  hasNegativeContentPatterns,
  evaluatePretoolContentNot,
};
