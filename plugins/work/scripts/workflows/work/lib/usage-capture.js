/**
 * usage-capture.js — pure `<usage>`-block parsing helpers (GH-311).
 *
 * Split from work-actions.js: these are side-effect-free parsers with no
 * state-file access. The persistence half (`appendUsage`, `USAGE_KIND`) stays
 * in work-actions.js next to the guarded `appendRow()` writer; work-actions
 * re-exports `parseUsageBlock` so callers keep a single import surface.
 */

/**
 * Coerce a captured `<usage>` field to a non-negative-safe number.
 * Any non-numeric / missing value yields `0` (NaN → 0) so the report never
 * propagates `NaN`. Never throws.
 * @param {string|number|undefined} value
 * @returns {number}
 */
function coerceUsageNumber(value) {
  const n = Number(value);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * Parse a `<usage>` block out of a Task() result string into a numeric record.
 *
 * GH-311 — Task 1, R1 (capture total_tokens/tool_uses/duration_ms), R7/C6
 * (graceful degradation, numeric coercion, no throw).
 *
 * Returns `{ totalTokens, toolUses, durationMs }` with each field coerced via
 * `Number(...)` (NaN → 0) when a `<usage>...</usage>` block is present, and
 * `null` when no such block exists or `text` is not a string. Missing
 * individual fields inside the block coerce to `0`; the function never throws.
 *
 * @param {string} text — raw Task() result string.
 * @returns {{totalTokens: number, toolUses: number, durationMs: number} | null}
 */
function parseUsageBlock(text) {
  if (typeof text !== 'string') return null;
  const block = text.match(/<usage>([\s\S]*?)<\/usage>/);
  if (!block) return null;

  const body = block[1];
  const field = (name) => {
    const m = body.match(new RegExp(`${name}\\s*:\\s*([^\\n\\r]*)`));
    return m ? m[1].trim() : undefined;
  };

  return {
    totalTokens: coerceUsageNumber(field('total_tokens')),
    toolUses: coerceUsageNumber(field('tool_uses')),
    durationMs: coerceUsageNumber(field('duration_ms')),
  };
}

module.exports = { coerceUsageNumber, parseUsageBlock };
