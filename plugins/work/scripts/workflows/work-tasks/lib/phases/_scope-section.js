/**
 * _scope-section.js — anchored `### <title>` section extraction for the
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
 * `work/lib/task-parser.js` documents the same trap and fixes it with a
 * `(?:^|\n)` anchor. Only the ANCHOR is borrowed, not that helper itself: its
 * pattern interpolates a literal heading line, so it requires exactly one space
 * after `###` and terminates on `\n###` rather than `\n###\s`. Delegating to it
 * silently narrowed both — `###  Files in scope` (two spaces) or a tab stopped
 * matching at all, which produces the very "lists no `*.test.*` file" false
 * rejection this module exists to prevent, and a `#### Sub-heading` inside the
 * section began truncating it. The pattern below keeps the original
 * `###\s+<title>` match and `\n###\s` terminator, and adds the anchor.
 */

'use strict';

/** Escape regex metacharacters in a section title. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Extract a `### ` section body, ignoring inline mentions of the heading.
 *
 * No `m` flag: under it `$` would match every line end and the terminator would
 * truncate a section whose last line has no trailing newline.
 *
 * @param {string} body - task block markdown.
 * @param {string} title - section title WITHOUT the leading `### `
 *   (e.g. `Files in scope`).
 * @returns {[string, string]|null} `[whole, sectionBody]`, match()-shaped so
 *   callers can keep reading index 1. null when the heading is absent.
 */
function matchScopeSection(body, title) {
  if (typeof body !== 'string' || !body) return null;
  const pattern = new RegExp(
    `(?:^|\\n)###\\s+${escapeRe(title)}[^\\n]*\\n([\\s\\S]*?)(?=\\n###\\s|\\n## |$(?![\\s\\S]))`
  );
  const m = body.match(pattern);
  return m ? [m[0], m[1]] : null;
}

module.exports = { matchScopeSection };
