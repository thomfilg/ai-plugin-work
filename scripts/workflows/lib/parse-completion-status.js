/**
 * parse-completion-status.js
 *
 * Shared helper for detecting an APPROVED/COMPLETE verdict in check reports
 * (completion.check.md, tests.check.md, code-review.check.md).
 *
 * Why: agents (and the canonical writer in check/scripts/write-completion-report.js)
 * emit the verdict in multiple equivalent forms — `Status: APPROVED`,
 * `Final Status\n\n**[COMPLETE]**`, `**Verdict:** **[COMPLETE]**`, etc.
 * Historically each consumer had its own regex (`/Status:\s*COMPLETE/`) which
 * only matched the simplest form, so a correctly-written report with
 * `## Final Status\n**[COMPLETE]**` was rejected. This module centralises a
 * tolerant matcher used by both work-next.js (work) and phase1-agents.js
 * (check2).
 */

'use strict';

/**
 * Build a regex that matches any of `verdicts` near a `Status`/`Verdict` label.
 * Accepts the canonical writer output:
 *   `## Final Status\n\n**[COMPLETE]**`
 * the agent-template form:
 *   `### Final Status:\n[COMPLETE]`
 * the legacy plain form:
 *   `Status: APPROVED`
 * and an alternate label commonly used by reviewers:
 *   `**Verdict:** **[APPROVED]**`
 *
 * Between the label and the verdict only formatting characters
 * (colon, whitespace incl. newline, asterisk, bracket) may appear — any other
 * character breaks the match, so it stays specific to the verdict region of
 * the document and won't false-positive on unrelated prose.
 *
 * @param {ReadonlyArray<string>} verdicts — values to match (e.g. ['COMPLETE', 'APPROVED'])
 * @returns {RegExp}
 */
function buildVerdictRegex(verdicts) {
  if (!Array.isArray(verdicts) || verdicts.length === 0) {
    throw new TypeError('buildVerdictRegex: verdicts must be a non-empty array');
  }
  const alt = verdicts.map(escapeRegex).join('|');
  // [:\s*] is the only allowed inter-character class between label and verdict.
  // \[? and \]? allow the bracketed form `[COMPLETE]`.
  return new RegExp(`(?:Status|Verdict)[:\\s*]*\\[?(${alt})\\]?`, 'i');
}

/**
 * Convenience: does `content` contain any of the listed verdicts?
 */
function hasVerdict(content, verdicts) {
  if (typeof content !== 'string' || !content) return false;
  return buildVerdictRegex(verdicts).test(content);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { buildVerdictRegex, hasVerdict };
