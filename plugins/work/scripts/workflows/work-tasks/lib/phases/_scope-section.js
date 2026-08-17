/**
 * _scope-section.js — anchored `### <heading>` section extraction for the
 * work-tasks gates.
 *
 * `kind_assign` and `scope_exists` both matched
 * `/###\s+Files in scope[^\n]*\n([\s\S]*?)(?=\n###\s|\n## |$(?![\s\S]))/`, which
 * is not anchored at start-of-line. A backticked mention in ordinary prose —
 * "- Document the `### Files in scope` convention" — therefore matched as the
 * heading, and the capture ran from that AC bullet to the REAL heading, so the
 * parsed file list came back empty. kind_assign then rejected a tdd-code task
 * whose scope plainly listed a test file.
 *
 * `work/lib/task-parser.js` already solved this and documents why; this module
 * delegates to its `extractSectionByHeading` so there is one implementation
 * rather than three copies of the regex, and falls back to a local anchored
 * pattern if that module cannot be loaded (it lives in a sibling workflow dir,
 * and `draft.js` guards its own import of it the same way).
 */

'use strict';

let extractSectionByHeading;
try {
  ({ extractSectionByHeading } = require('../../../work/lib/task-parser'));
} catch {
  extractSectionByHeading = null;
}

/**
 * Local equivalent of task-parser's helper. Anchored via `(?:^|\n)`; no `m`
 * flag, because that would redefine `$` in the terminator and truncate a
 * section whose last line has no trailing newline.
 *
 * @param {string} body
 * @param {string} heading - literal heading line including the leading `### `.
 * @returns {[string, string]|null}
 */
function extractLocal(body, heading) {
  const pattern = new RegExp(
    `(?:^|\\n)${heading}[^\\n]*\\n([\\s\\S]*?)(?=\\n###\\s|\\n## |$(?![\\s\\S]))`
  );
  const m = body.match(pattern);
  return m ? [m[0], m[1]] : null;
}

/**
 * Extract a `### ` section body, ignoring inline mentions of the heading.
 *
 * @param {string} body - task block markdown.
 * @param {string} heading - literal heading line including the leading `### `.
 * @returns {[string, string]|null} `[whole, sectionBody]`, match()-shaped so
 *   callers can keep reading index 1. null when the heading is absent.
 */
function matchScopeSection(body, heading) {
  if (typeof body !== 'string' || !body) return null;
  if (extractSectionByHeading) return extractSectionByHeading(body, heading);
  return extractLocal(body, heading);
}

module.exports = { matchScopeSection };
