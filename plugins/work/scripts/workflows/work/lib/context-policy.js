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
 *   - parseThresholds(raw)                 → sorted, unique, default-on-invalid %s
 *   - resolveContextLimit(override, window)→ token limit: override > window > default
 *   - percentUsed(tokens, limit)           → integer floor percent, clamped [0,100]
 *   - newlyCrossed(pct, thresholds, hit)   → once-per-threshold crossing decision
 *   - renderWarning({...})                 → human-readable warning string
 */

/** Default warning thresholds (percent of context limit). */
const DEFAULT_THRESHOLDS = Object.freeze([60, 70, 80]);

/**
 * Safe default context-token limit, used only when neither an explicit
 * `WORK_CONTEXT_LIMIT` override nor a transcript-reported `model_context_window`
 * is available. Claude transcripts do not report a window, so a Claude session
 * falls back to this unless the operator sets `WORK_CONTEXT_LIMIT`; codex
 * transcripts carry the real window and use it directly.
 */
const DEFAULT_CONTEXT_LIMIT = 200000;

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
 * Resolve the context-token limit from, in priority order: a valid
 * positive-integer `override` (from `WORK_CONTEXT_LIMIT`), then the
 * transcript-reported `transcriptWindow` (codex's `model_context_window`), then
 * `DEFAULT_CONTEXT_LIMIT`. Invalid / zero / non-numeric inputs are ignored at
 * each tier. The limit is derived from the transcript, not the agent type —
 * the dispatched *agent type* is never a model id, so a model-name map would be
 * dead code that always fell through to the default.
 *
 * @param {unknown} [override] explicit limit (WORK_CONTEXT_LIMIT)
 * @param {unknown} [transcriptWindow] window reported by the transcript
 * @returns {number} the token limit
 */
function resolveContextLimit(override, transcriptWindow) {
  const overrideLimit = toPositiveInt(override);
  if (overrideLimit !== null) return overrideLimit;
  const windowLimit = toPositiveInt(transcriptWindow);
  if (windowLimit !== null) return windowLimit;
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
  resolveContextLimit,
  percentUsed,
  newlyCrossed,
  renderWarning,
};
