'use strict';

/**
 * context-usage.js
 *
 * Cumulative context-token reader for the `/work` context-window monitor
 * (GH-313, Task 2). Reads the session's own transcript JSONL and returns a
 * single cumulative context-token count, branching on the runtime format:
 *
 *   - claude / unknown: SUM the per-turn `usage` token fields
 *     (`input_tokens` + `output_tokens`, plus the cache token fields when
 *     present) across every turn — the token counts are per-turn deltas.
 *   - codex: take the LAST `token_count` record's `total_token_usage`, which
 *     is already a CUMULATIVE running total (summing the per-turn snapshots
 *     would massively over-count). Prefer its `total_tokens`, else sum the
 *     recognized fields.
 *
 * Fail-safe by contract: a missing / empty / unreadable transcript, or a
 * corrupt JSONL line, degrades to a safe `0` — it never throws — so the
 * fail-open PostToolUse caller can no-op. Zero runtime dependencies, CommonJS.
 *
 * `sniffFormat` (from the shared runtime transcript facade) is consulted
 * READ-ONLY for claude/codex format detection and is LOAD-BEARING: it selects
 * the summation strategy. No sibling-owned file is modified.
 */

const fs = require('node:fs');
const { sniffFormat } = require('../../lib/runtime/transcript');

/** Per-turn `usage` token fields summed into the cumulative total (claude). */
const USAGE_TOKEN_FIELDS = Object.freeze([
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
]);

/**
 * Codex `total_token_usage` fields summed as a FALLBACK when `total_tokens` is
 * absent. `cached_input_tokens` is a subset of `input_tokens` on the codex
 * shape, so it is intentionally NOT summed here (that would double-count);
 * `reasoning_output_tokens` is a subset of `output_tokens` for the same reason.
 */
const CODEX_TOTAL_TOKEN_FIELDS = Object.freeze(['input_tokens', 'output_tokens']);

/**
 * Coerce a candidate token value to a non-negative finite number, or 0.
 * @param {unknown} value
 * @returns {number}
 */
function toTokenCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Locate the `usage` object on a parsed transcript record. Claude records nest
 * it under `message.usage`; some shapes place it at the top level. Returns the
 * first plain object found, or null.
 *
 * @param {object} record a parsed JSONL record
 * @returns {object|null}
 */
function extractUsageBlock(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.usage && typeof record.usage === 'object') return record.usage;
  if (record.message && typeof record.message.usage === 'object') {
    return record.message.usage;
  }
  return null;
}

/**
 * Sum the recognized token fields on a single `usage` block.
 * @param {object|null} block
 * @returns {number}
 */
function sumUsageBlock(block) {
  if (!block) return 0;
  let total = 0;
  for (const field of USAGE_TOKEN_FIELDS) {
    total += toTokenCount(block[field]);
  }
  return total;
}

/**
 * Parse one JSONL line and return its token contribution. A blank or corrupt
 * line contributes 0 (skipped defensively) so a single bad line never aborts
 * the whole read.
 *
 * @param {string} line raw JSONL line
 * @returns {number}
 */
function tokensFromLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return 0;
  let record;
  try {
    record = JSON.parse(trimmed);
  } catch {
    return 0;
  }
  return sumUsageBlock(extractUsageBlock(record));
}

/**
 * Whether a parsed record is a codex `token_count` snapshot.
 * @param {unknown} record a parsed JSONL record
 * @returns {boolean}
 */
function isCodexTokenCount(record) {
  if (!record || typeof record !== 'object' || record.type !== 'event_msg') return false;
  const payload = record.payload;
  return Boolean(payload) && typeof payload === 'object' && payload.type === 'token_count';
}

/**
 * Cumulative total from a codex `total_token_usage` block. Prefers the block's
 * own `total_tokens` (already cumulative); otherwise sums the recognized
 * fields. A missing / corrupt block yields 0.
 *
 * @param {unknown} usageTotal `payload.info.total_token_usage`
 * @returns {number}
 */
function codexUsageTotal(usageTotal) {
  if (!usageTotal || typeof usageTotal !== 'object') return 0;
  const explicit = toTokenCount(usageTotal.total_tokens);
  if (explicit > 0) return explicit;
  let total = 0;
  for (const field of CODEX_TOTAL_TOKEN_FIELDS) {
    total += toTokenCount(usageTotal[field]);
  }
  return total;
}

/**
 * Extract the cumulative token total from a codex `token_count` record.
 * Returns null when the record is not a `token_count` snapshot (so the caller
 * can skip it); a `token_count` record with a missing / corrupt total block
 * contributes 0.
 *
 * @param {object} record a parsed JSONL record
 * @returns {number|null}
 */
function codexTokenCountTotal(record) {
  if (!isCodexTokenCount(record)) return null;
  return codexUsageTotal(record.payload.info && record.payload.info.total_token_usage);
}

/**
 * Codex leg: `total_token_usage` is a CUMULATIVE running total re-emitted each
 * turn, so the cumulative context size is the LAST `token_count` snapshot — NOT
 * the sum across snapshots. Malformed lines and non-`token_count` records are
 * skipped; an absent snapshot degrades to 0.
 *
 * @param {string} raw whole-file transcript text
 * @returns {number} cumulative context tokens (>= 0)
 */
function readCodexCumulativeUsage(raw) {
  let last = 0;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const total = codexTokenCountTotal(record);
    if (total !== null) last = total;
  }
  return last;
}

/**
 * Claude / unknown leg: SUM the per-turn `usage` blocks (the token counts are
 * per-turn deltas). Malformed and blank lines contribute 0.
 *
 * @param {string} raw whole-file transcript text
 * @returns {number} cumulative context tokens (>= 0)
 */
function readClaudeCumulativeUsage(raw) {
  let total = 0;
  for (const line of raw.split(/\r?\n/)) {
    total += tokensFromLine(line);
  }
  return total;
}

/**
 * Read the transcript at `transcriptPath` and return its cumulative context
 * token count. Branches on the sniffed runtime format (see the module header):
 * codex takes the last cumulative `token_count` snapshot; claude/unknown sum
 * per-turn `usage` blocks. Returns 0 for a missing, empty, or unreadable
 * transcript, and skips malformed lines — never throws.
 *
 * @param {string|undefined|null} transcriptPath path to the transcript JSONL
 * @returns {number} cumulative context tokens (>= 0)
 */
function readCumulativeUsage(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return 0;
  let format;
  let raw;
  try {
    // Consult the shared sniff read-only; it selects the summation strategy.
    format = sniffFormat(transcriptPath);
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return 0;
  }
  return format === 'codex' ? readCodexCumulativeUsage(raw) : readClaudeCumulativeUsage(raw);
}

module.exports = {
  readCumulativeUsage,
  USAGE_TOKEN_FIELDS,
};
