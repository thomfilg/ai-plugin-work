/**
 * brief-sibling-gaps.js
 *
 * Gate A — parses two sections out of `tasks/<ticket>/brief.md`:
 *   - `## Out of scope (sibling-owned)` — declarations that a needed surface
 *     is owned by a sibling ticket. The brief-writer is required to put one
 *     entry per surface here, formatted as a bullet line.
 *   - `## Sibling-gap decisions` — the user's recorded choice per entry:
 *     either "implement here as an exception" or "wait for sibling".
 *
 * The validator returns any out-of-scope entries that lack a matching
 * decision. The brief-gate enrichment uses those to drive AskUserQuestion.
 *
 * Pure module — no fs / no MCP / no agent calls.
 */

'use strict';

const SECTION_HEADERS = {
  outOfScope: /^##\s+Out of scope\s+\(sibling-owned\)\s*$/im,
  decisions: /^##\s+Sibling-gap decisions\s*$/im,
};

function _sliceSection(text, headerRe) {
  const m = text.match(headerRe);
  if (!m) return null;
  const start = m.index + m[0].length;
  const after = text.slice(start);
  const next = after.match(/^##\s/m);
  return next ? after.slice(0, next.index) : after;
}

function _parseBulletEntries(body) {
  if (!body) return [];
  const lines = body.split('\n');
  const entries = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('<!--')) continue;
    if (!/^[-*+]\s+/.test(line)) continue;
    entries.push(line.replace(/^[-*+]\s+/, '').trim());
  }
  return entries;
}

/**
 * Extract a sibling ticket ID from an Out-of-scope entry. Entries follow
 * the brief-writer template:
 *   - `<SURFACE>` — owned by <TICKET-ID> (status: <STATUS>, PR: <#N>). Reason: <text>.
 * The ticket ID is required for AskUserQuestion phrasing.
 *
 * @param {string} entry
 * @returns {{ surface:string, ticketId:string|null, raw:string }}
 */
function _decomposeOosEntry(entry) {
  const ownedBy = entry.match(/owned by\s+([A-Z]+-\d+|GH-\d+|#\d+)/i);
  const ticketId = ownedBy ? ownedBy[1] : null;
  // Surface is the leading token, optionally backtick-wrapped. Stop at the
  // first ` — ` (space-emdash-space), ` -- `, or `  ` separator. Hyphens
  // INSIDE a path are kept (e.g. `lib/validation/workbook-view.ts`).
  let surface;
  const backtickMatch = entry.match(/^`([^`]+)`/);
  if (backtickMatch) {
    surface = backtickMatch[1].trim();
  } else {
    const sepMatch = entry.match(/^(.+?)(?:\s+—\s+|\s+--\s+|\s+owned by\s+)/i);
    surface = sepMatch ? sepMatch[1].trim() : entry.split(/\s+/)[0];
  }
  return { surface, ticketId, raw: entry };
}

/**
 * Parse a Sibling-gap decisions entry. Expected formats produced by
 * brief_gate's AskUserQuestion persistence:
 *   - `<SURFACE>` — decision: implement-here; timestamp: 2026-05-13T...
 *   - `<SURFACE>` — decision: wait-for-sibling; …
 * For matching purposes only the surface token matters.
 *
 * @param {string} entry
 * @returns {{ surface:string, raw:string }}
 */
function _decomposeDecisionEntry(entry) {
  let surface;
  const backtickMatch = entry.match(/^`([^`]+)`/);
  if (backtickMatch) {
    surface = backtickMatch[1].trim();
  } else {
    const sepMatch = entry.match(/^(.+?)(?:\s+—\s+|\s+--\s+)/);
    surface = sepMatch ? sepMatch[1].trim() : entry.split(/\s+/)[0];
  }
  return { surface, raw: entry };
}

/**
 * Compare Out-of-scope entries against recorded decisions. Returns entries
 * that have no matching decision (by surface string, case-insensitive).
 *
 * @param {string} briefText
 * @returns {{ outOfScope: Array<object>, decisions: Array<object>, unresolved: Array<object> }}
 */
function findUnresolvedSiblingGaps(briefText) {
  if (typeof briefText !== 'string' || briefText.length === 0) {
    return { outOfScope: [], decisions: [], unresolved: [] };
  }
  const oosBody = _sliceSection(briefText, SECTION_HEADERS.outOfScope);
  const decBody = _sliceSection(briefText, SECTION_HEADERS.decisions);
  const outOfScope = _parseBulletEntries(oosBody).map(_decomposeOosEntry);
  const decisions = _parseBulletEntries(decBody).map(_decomposeDecisionEntry);
  const decided = new Set(decisions.map((d) => d.surface.toLowerCase()));
  const unresolved = outOfScope.filter((e) => !decided.has(e.surface.toLowerCase()));
  return { outOfScope, decisions, unresolved };
}

/**
 * Build AskUserQuestion-shaped questions for each unresolved gap. Surface
 * the sibling ticket ID in the question text so the user can decide
 * informed.
 *
 * @param {Array<{surface:string, ticketId:string|null, raw:string}>} unresolved
 * @param {string} currentTicketId
 * @returns {Array<{questionText:string, scope:'user', rationale:string}>}
 */
function buildSiblingGapQuestions(unresolved, currentTicketId) {
  if (!Array.isArray(unresolved)) return [];
  return unresolved.map((u) => {
    const owner = u.ticketId || 'unknown sibling';
    const here = currentTicketId || 'current ticket';
    return {
      questionText:
        `Surface "${u.surface}" is needed for ${here} but is owned by sibling ${owner}. ` +
        `Implement the gap here as an exception, or complete ${owner} first?`,
      scope: 'user',
      rationale: u.raw,
    };
  });
}

module.exports = {
  findUnresolvedSiblingGaps,
  buildSiblingGapQuestions,
  _decomposeOosEntry,
  _decomposeDecisionEntry,
};
