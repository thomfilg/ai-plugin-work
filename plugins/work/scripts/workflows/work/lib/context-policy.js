'use strict';

/**
 * context-policy.js
 *
 * Pure decision helpers for the `/work` context-window usage monitor
 * (GH-313). No side effects, no I/O, no runtime dependencies — every export
 * is a total function over its inputs so the fail-open PostToolUse hook can
 * call them without a try/catch of its own.
 *
 * Exports:
 *   - parseThresholds(raw)              → sorted, unique, default-on-invalid %s
 *   - modelContextLimit(model, override)→ token limit with a safe 200000 default
 *   - percentUsed(tokens, limit)        → integer floor percent, clamped [0,100]
 *   - newlyCrossed(pct, thresholds, hit)→ once-per-threshold crossing decision
 *   - renderWarning({...})              → human-readable warning string
 */

/** Default warning thresholds (percent of context limit). */
const DEFAULT_THRESHOLDS = Object.freeze([60, 70, 80]);

/** Safe default / per-model context-token limit. */
const DEFAULT_CONTEXT_LIMIT = 200000;

/**
 * Model → context-token-limit map. Opus / Sonnet / Haiku all currently share a
 * 200000-token window; matching is by lower-cased substring so version-suffixed
 * ids (e.g. `claude-opus-4-8`) resolve without an exhaustive id table.
 */
const MODEL_LIMITS = Object.freeze([
  Object.freeze({ match: 'opus', limit: 200000 }),
  Object.freeze({ match: 'sonnet', limit: 200000 }),
  Object.freeze({ match: 'haiku', limit: 200000 }),
]);

/**
 * Coerce a value to a positive, finite integer, or return null.
 * The shared numeric-validation guard used by the threshold parser and the
 * context-limit override so both reject NaN / non-finite / non-positive input
 * identically.
 *
 * @param {unknown} value candidate value (string or number)
 * @returns {number|null} the positive integer, or null when invalid
 */
function toPositiveInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.floor(n);
}

/**
 * Parse a comma-separated threshold list into a sorted, de-duplicated array of
 * positive integer percentages. Mirrors the `WORK_PRICING` parse-with-fallback
 * shape: any missing / empty / fully-invalid input yields a fresh copy of the
 * default `[60,70,80]` (never the shared frozen constant, so callers may
 * mutate the result safely).
 *
 * @param {string|null|undefined} raw e.g. "50,90"
 * @returns {number[]} sorted unique percentages, or the defaults
 */
function parseThresholds(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return [...DEFAULT_THRESHOLDS];
  }
  const parsed = raw
    .split(',')
    .map((part) => toPositiveInt(part.trim()))
    .filter((n) => n !== null);
  if (parsed.length === 0) return [...DEFAULT_THRESHOLDS];
  return [...new Set(parsed)].sort((a, b) => a - b);
}

/**
 * Resolve the context-token limit for a model, honoring an explicit override.
 * A valid positive-integer `override` (from `WORK_CONTEXT_LIMIT`) wins over the
 * model map; an invalid override is ignored. An unknown / undefined model
 * falls back to `DEFAULT_CONTEXT_LIMIT`.
 *
 * @param {string|undefined} model the model id
 * @param {unknown} [override] optional explicit limit
 * @returns {number} the token limit
 */
function modelContextLimit(model, override) {
  const overrideLimit = toPositiveInt(override);
  if (overrideLimit !== null) return overrideLimit;
  if (typeof model === 'string') {
    const lower = model.toLowerCase();
    const entry = MODEL_LIMITS.find((m) => lower.includes(m.match));
    if (entry) return entry.limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

/**
 * Integer floor percent of `cumulativeTokens` against `limit`, guarded against
 * a zero/negative limit (→ 0) and clamped to a maximum of 100.
 *
 * @param {number} cumulativeTokens tokens consumed so far
 * @param {number} limit the context-token limit
 * @returns {number} integer percent in [0, 100]
 */
function percentUsed(cumulativeTokens, limit) {
  if (!Number.isFinite(limit) || limit <= 0) return 0;
  const tokens = Number.isFinite(cumulativeTokens) && cumulativeTokens > 0 ? cumulativeTokens : 0;
  const pct = Math.floor((tokens / limit) * 100);
  return Math.min(pct, 100);
}

/**
 * The once-per-threshold decision: which configured thresholds are now crossed
 * (`<= percent`) but were NOT already recorded as crossed. Result is sorted
 * ascending so warnings fire lowest-first.
 *
 * @param {number} percent current integer percent used
 * @param {number[]} thresholds configured thresholds
 * @param {number[]} alreadyCrossed thresholds already fired this session
 * @returns {number[]} newly-crossed thresholds, ascending
 */
function newlyCrossed(percent, thresholds, alreadyCrossed) {
  const crossed = new Set(Array.isArray(alreadyCrossed) ? alreadyCrossed : []);
  const list = Array.isArray(thresholds) ? thresholds : [];
  return list.filter((t) => t <= percent && !crossed.has(t)).sort((a, b) => a - b);
}

/**
 * Compose the human-readable context-usage warning. Always names the active
 * workflow step, the dispatched agent/tool, and the integer percent (e.g.
 * `62%`). When `isCritical` it appends the actionable recommendation to commit
 * current work and spawn a fresh agent for the remainder.
 *
 * @param {object} params
 * @param {number} params.percent integer percent consumed
 * @param {string} params.step active workflow step name
 * @param {string} params.agent dispatched agent / tool name
 * @param {number} params.threshold the threshold that fired
 * @param {boolean} params.isCritical whether this is the highest threshold
 * @returns {string} the warning message
 */
function renderWarning({ percent, step, agent, threshold, isCritical }) {
  const lines = [
    `[/work context] ${percent}% of the model context window is used ` +
      `(crossed the ${threshold}% threshold).`,
    `Active step: ${step}. Dispatched agent/tool: ${agent}.`,
  ];
  if (isCritical) {
    lines.push(
      'Recommendation: commit current work now, summarize progress, and ' +
        'consider spawning a fresh agent to continue the remainder.'
    );
  }
  return lines.join('\n');
}

module.exports = {
  DEFAULT_THRESHOLDS,
  DEFAULT_CONTEXT_LIMIT,
  parseThresholds,
  modelContextLimit,
  percentUsed,
  newlyCrossed,
  renderWarning,
};
