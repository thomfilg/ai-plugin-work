/**
 * brief-spec-coverage.js
 *
 * Gate B — pure parsers + coverage check for the brief↔spec contract.
 *
 * Rules enforced:
 *   1. Every P0 ID in the brief's `### Must Have (P0)` section MUST appear
 *      somewhere in the spec (either as a heading anchor `### P0 #N` or
 *      as an explicit reference like "covers P0 #1" / "P0 #1:" in a section).
 *   2. The spec MUST restate the brief's `## Out of scope (sibling-owned)`
 *      section verbatim under its own `## Out of scope (sibling-owned)`
 *      heading. (Gate A's surfaces remain forbidden in the spec.)
 *
 * No fs, no MCP, no agents — pure text in / structured result out.
 */

'use strict';

const P0_HEADING_RE = /^###\s+Must Have\s*\(P0\)\s*$/im;

/**
 * Extract P0 IDs from a brief's `### Must Have (P0)` section.
 * Accepts numbered items (`1.`, `2.`) and bulleted items prefixed by `**P0 #N**`.
 * Returns an ordered, deduplicated list of IDs as strings like "1", "2".
 *
 * @param {string} briefText
 * @returns {string[]}
 */
function extractP0Ids(briefText) {
  if (typeof briefText !== 'string' || briefText.length === 0) return [];
  const m = briefText.match(P0_HEADING_RE);
  if (!m) return [];
  const after = briefText.slice(m.index + m[0].length);
  const stop = after.match(/^###\s+|^##\s+/m);
  const body = stop ? after.slice(0, stop.index) : after;
  const ids = [];
  const seen = new Set();
  const lineRe = /(?:^|\n)\s*(?:(\d+)\.\s+|[-*+]\s+\*\*?P0\s*#(\d+)\*\*?\s*[:\-—]?\s*)/g;
  let match;
  while ((match = lineRe.exec(body)) !== null) {
    const id = match[1] || match[2];
    if (!id) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Check whether a spec mentions each P0 ID. Acceptance criteria for a
 * "covered" P0:
 *   - The spec has a heading containing `P0 #N` (any heading level), OR
 *   - The spec body contains a line matching `(?:^|\W)P0\s*#?N(?:\D|$)` AND that
 *     line is within a recognizable section (heuristic: any `###` or `####`
 *     heading appearing in spec, no further constraint).
 * Conservative: accept any occurrence of `P0 #N` in the spec text.
 *
 * @param {string} specText
 * @param {string[]} p0Ids
 * @returns {{ covered: string[], missing: string[] }}
 */
function checkP0Coverage(specText, p0Ids) {
  if (typeof specText !== 'string' || !Array.isArray(p0Ids)) {
    return { covered: [], missing: Array.isArray(p0Ids) ? p0Ids.slice() : [] };
  }
  const covered = [];
  const missing = [];
  for (const id of p0Ids) {
    const re = new RegExp(`(?:^|\\W)P0\\s*#?${id}(?:\\D|$)`, 'm');
    if (re.test(specText)) covered.push(id);
    else missing.push(id);
  }
  return { covered, missing };
}

/**
 * Verify the spec restates the brief's `## Out of scope (sibling-owned)`
 * section. Match is lossy — we require the heading to be present in the
 * spec AND at least one entry from the brief's OOS section to appear in
 * the spec's OOS section.
 *
 * @param {string} briefText
 * @param {string} specText
 * @returns {{ ok: boolean, reason?: string, missingEntries?: string[] }}
 */
function checkSiblingOosRestatement(briefText, specText) {
  if (typeof briefText !== 'string' || typeof specText !== 'string') {
    return { ok: true };
  }
  const briefOos = _extractSectionBody(briefText, /^##\s+Out of scope\s*\(sibling-owned\)\s*$/im);
  if (!briefOos) return { ok: true }; // nothing to restate
  const specOos = _extractSectionBody(specText, /^##\s+Out of scope\s*\(sibling-owned\)\s*$/im);
  if (!specOos) {
    return {
      ok: false,
      reason:
        'brief has `## Out of scope (sibling-owned)` but the spec is missing this section. Restate it verbatim.',
    };
  }
  const briefEntries = _parseBullets(briefOos);
  const specEntries = _parseBullets(specOos);
  const specSet = new Set(specEntries.map((e) => _surfaceToken(e)));
  const missing = briefEntries.filter((e) => !specSet.has(_surfaceToken(e)));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'spec OOS section is missing entries from brief OOS section',
      missingEntries: missing,
    };
  }
  return { ok: true };
}

function _extractSectionBody(text, headerRe) {
  const m = text.match(headerRe);
  if (!m) return null;
  const after = text.slice(m.index + m[0].length);
  const next = after.match(/^##\s/m);
  return next ? after.slice(0, next.index) : after;
}

function _parseBullets(body) {
  return body
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^[-*+]\s+/.test(l))
    .map((l) => l.replace(/^[-*+]\s+/, '').trim());
}

function _surfaceToken(bulletEntry) {
  const bt = bulletEntry.match(/^`([^`]+)`/);
  if (bt) return bt[1].toLowerCase();
  const sep = bulletEntry.match(/^(.+?)(?:\s+—\s+|\s+--\s+|\s+owned by\s+)/i);
  return (sep ? sep[1] : bulletEntry.split(/\s+/)[0]).toLowerCase();
}

module.exports = {
  extractP0Ids,
  checkP0Coverage,
  checkSiblingOosRestatement,
};
