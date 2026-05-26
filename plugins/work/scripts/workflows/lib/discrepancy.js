/**
 * discrepancy.js
 *
 * Gate B' — extract "claims" (assertions about scope, files, behaviors,
 * acceptance criteria) from one or more workflow artifacts and compare
 * them pairwise. Highest-precedence source overrides lower-precedence;
 * mismatches surface as questions for the user to resolve.
 *
 * The artifacts (in precedence order, highest first). The hierarchy
 * follows the upstream-source principle: any artifact under review at a
 * gate must not silently drop or invent claims relative to UPSTREAM
 * sources. Hence the literal user prompt is the highest authority, the
 * ticket text is next (system of record), and each derived artifact
 * (brief → spec → tasks) is lower than what it was derived from.
 *
 *   - user-prompt.md     — captured at bootstrap from the literal user text
 *   - ticket text        — fetched from the ticket provider (system of record)
 *   - brief.md           — brief-writer output (derived from ticket + prompt)
 *   - spec.md            — spec-writer output (derived from brief)
 *   - tasks.md           — split-in-tasks output (derived from spec)
 *
 * When `brief_gate` runs, "brief" is the lower artifact under review; the
 * gate compares it against `user prompt` and `ticket` (both higher). When
 * `spec_gate` runs, "spec" is the lower; compares against user prompt /
 * ticket / brief. When `implement`'s tasks-discrepancy hook runs, "tasks"
 * is the lower; compares against all four higher sources.
 *
 * "Claims" are normalized tokens we can compare:
 *   - file paths / globs (backticked or quoted)
 *   - symbols (CamelCase identifiers, snake_case names with `.` like `views.list`)
 *   - explicit acceptance/should/must lines
 *
 * Pure module — no fs, no MCP, no agents. The caller passes in the
 * artifact texts and gets back a discrepancy report.
 */

'use strict';

const BACKTICKED_RE = /`([^`\n]+)`/g;
const SYMBOL_RE = /\b([A-Z][A-Za-z0-9]+(?:\.[A-Za-z0-9_]+)+)\b/g;

/**
 * Normalize a claim token for comparison: lowercase, strip trailing
 * punctuation, drop whitespace.
 */
function _normalize(token) {
  return String(token || '')
    .trim()
    .toLowerCase()
    .replace(/[.,;:!?]+$/, '');
}

/**
 * Extract claim tokens from one artifact's text. Returns a Set<string>.
 * Tokens are deduped and normalized.
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function extractClaims(text) {
  const out = new Set();
  if (typeof text !== 'string' || text.length === 0) return out;

  let m;
  BACKTICKED_RE.lastIndex = 0;
  while ((m = BACKTICKED_RE.exec(text)) !== null) {
    const n = _normalize(m[1]);
    if (n) out.add(n);
  }

  SYMBOL_RE.lastIndex = 0;
  while ((m = SYMBOL_RE.exec(text)) !== null) {
    const n = _normalize(m[1]);
    if (n) out.add(n);
  }

  return out;
}

/**
 * Compare claims across two artifacts. Returns:
 *   - missingInLower: claims in `higher` but not `lower` (lower may be silently dropping)
 *   - extraInLower:   claims in `lower` but not `higher` (lower may be inventing)
 *
 * `higher` is the higher-precedence source; `lower` is the artifact under review.
 *
 * @param {Set<string>|string} higher
 * @param {Set<string>|string} lower
 * @returns {{ missingInLower:string[], extraInLower:string[] }}
 */
function compareClaims(higher, lower) {
  const hSet = higher instanceof Set ? higher : extractClaims(higher);
  const lSet = lower instanceof Set ? lower : extractClaims(lower);
  const missingInLower = [];
  const extraInLower = [];
  for (const c of hSet) if (!lSet.has(c)) missingInLower.push(c);
  for (const c of lSet) if (!hSet.has(c)) extraInLower.push(c);
  return { missingInLower, extraInLower };
}

/**
 * Build AskUserQuestion-shaped questions from a discrepancy comparison.
 * Each question phrases the drift in terms of the precedence hierarchy
 * and offers options for the user to resolve.
 *
 * @param {{missingInLower:string[], extraInLower:string[]}} comparison
 * @param {string} higherLabel - e.g. 'user prompt'
 * @param {string} lowerLabel  - e.g. 'brief'
 * @returns {Array<{questionText:string, scope:'user', rationale:string}>}
 */
function buildDiscrepancyQuestions(comparison, higherLabel, lowerLabel) {
  if (!comparison) return [];
  const qs = [];
  for (const claim of comparison.missingInLower) {
    qs.push({
      questionText:
        `${higherLabel} mentions \`${claim}\` but ${lowerLabel} does not. ` +
        `Is this a drop in ${lowerLabel} that needs to be added, or was the ${higherLabel} mention out-of-date?`,
      scope: 'user',
      rationale: `Discrepancy: claim "${claim}" present in ${higherLabel}, absent in ${lowerLabel}.`,
    });
  }
  for (const claim of comparison.extraInLower) {
    qs.push({
      questionText:
        `${lowerLabel} introduces \`${claim}\` but ${higherLabel} does not mention it. ` +
        `Is this a legitimate ${lowerLabel}-level decision, or scope creep that should be removed?`,
      scope: 'user',
      rationale: `Discrepancy: claim "${claim}" absent in ${higherLabel}, present in ${lowerLabel}.`,
    });
  }
  return qs;
}

/**
 * Read the "Discrepancy decisions" section from an artifact and return the
 * set of claim tokens that already have a recorded answer. The gate uses
 * this to avoid re-prompting on every /work invocation.
 *
 * Decisions are bullets formatted like:
 *   - `<claim>` — decision: <text>; timestamp: <ISO>
 *
 * @param {string} text
 * @returns {Set<string>}
 */
function extractRecordedDecisions(text) {
  const out = new Set();
  if (typeof text !== 'string' || text.length === 0) return out;
  const m = text.match(/^##\s+Discrepancy decisions\s*$/im);
  if (!m) return out;
  const after = text.slice(m.index + m[0].length);
  const stop = after.match(/^##\s/m);
  const body = stop ? after.slice(0, stop.index) : after;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('-')) continue;
    const bt = line.match(/`([^`]+)`/);
    if (bt) out.add(_normalize(bt[1]));
  }
  return out;
}

/**
 * Filter discrepancy questions, removing any whose claim already has a
 * recorded decision.
 */
function filterUnresolved(questions, decisions) {
  if (!Array.isArray(questions)) return [];
  if (!(decisions instanceof Set)) return questions;
  return questions.filter((q) => {
    const claim = (q.rationale.match(/"([^"]+)"/) || [])[1];
    return !claim || !decisions.has(_normalize(claim));
  });
}

module.exports = {
  extractClaims,
  compareClaims,
  buildDiscrepancyQuestions,
  extractRecordedDecisions,
  filterUnresolved,
};
