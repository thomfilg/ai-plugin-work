'use strict';

/**
 * context-usage.js
 *
 * Current context-window occupancy reader for the `/work` context-window
 * monitor (GH-313, Task 2). Reads the session's own transcript JSONL and
 * returns the CURRENT occupancy — the size of the most recent turn's context,
 * NOT a sum across turns.
 *
 * Summing the per-turn `usage` blocks over a long session massively
 * over-counts: each turn re-sends (and re-reports) the growing, cached context,
 * so the sum is a cumulative-of-cumulatives with no relationship to how full
 * the window actually is. The occupancy the monitor cares about is the LAST
 * turn's usage, on both runtimes:
 *
 *   - claude / unknown: the LAST `usage` block's `input_tokens` +
 *     `output_tokens` + the cache token fields (`cache_read_input_tokens` +
 *     `cache_creation_input_tokens`) — the full prompt + response of the most
 *     recent turn, i.e. the current window occupancy.
 *   - codex: the LAST `token_count` snapshot's `last_token_usage.total_tokens`
 *     (the most recent turn), preferred over `total_token_usage` — which is a
 *     cumulative running COST total that also grows unbounded over a session.
 *     The snapshot's `model_context_window` is surfaced as the real limit.
 *
 * Fail-safe by contract: a missing / empty / unreadable transcript, or a
 * corrupt JSONL line, degrades to a safe `{ tokens: 0, contextWindow: 0 }` — it
 * never throws — so the fail-open PostToolUse caller can no-op. Zero runtime
 * dependencies, CommonJS.
 *
 * Only the transcript TAIL is read (the last-turn occupancy lives at the end of
 * the file), so cost stays bounded regardless of transcript size; a partial
 * tail that yields no usage falls back to a full read.
 *
 * `sniffFormat` (from the shared runtime transcript facade) is consulted
 * READ-ONLY for claude/codex format detection and is LOAD-BEARING: it selects
 * the occupancy strategy. No sibling-owned file is modified.
 */

const fs = require('node:fs');
const { sniffFormat } = require('../../lib/runtime/transcript');

/** Bytes of the transcript tail scanned for the last-turn occupancy. */
const TAIL_BYTES = 512 * 1024;

/** Per-turn `usage` token fields summed into the occupancy total (claude). */
const USAGE_TOKEN_FIELDS = Object.freeze([
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
]);

/**
 * Codex token-usage fields summed as a FALLBACK when `total_tokens` is absent.
 * `cached_input_tokens` is a subset of `input_tokens` on the codex shape, so it
 * is intentionally NOT summed here (that would double-count);
 * `reasoning_output_tokens` is a subset of `output_tokens` for the same reason.
 */
const CODEX_TOKEN_FIELDS = Object.freeze(['input_tokens', 'output_tokens']);

/** A fresh empty (no-usage) result. */
function emptyUsage() {
  return { tokens: 0, contextWindow: 0 };
}

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
 * Occupancy from a single codex token-usage block. Prefers the block's own
 * `total_tokens`; otherwise sums the recognized fields. A missing / corrupt
 * block yields 0.
 *
 * @param {unknown} usageBlock a codex `last_token_usage` / `total_token_usage`
 * @returns {number}
 */
function codexUsageTotal(usageBlock) {
  if (!usageBlock || typeof usageBlock !== 'object') return 0;
  const explicit = toTokenCount(usageBlock.total_tokens);
  if (explicit > 0) return explicit;
  let total = 0;
  for (const field of CODEX_TOKEN_FIELDS) {
    total += toTokenCount(usageBlock[field]);
  }
  return total;
}

/**
 * Current-turn occupancy from a codex `token_count` payload.info. Prefers
 * `last_token_usage` (the most recent turn's usage) over `total_token_usage`
 * (a cumulative running total that grows unbounded). Returns null when neither
 * block is present so the caller can skip the record.
 *
 * @param {unknown} info `payload.info`
 * @returns {number|null}
 */
function codexTurnOccupancy(info) {
  if (!info || typeof info !== 'object') return null;
  if (info.last_token_usage && typeof info.last_token_usage === 'object') {
    return codexUsageTotal(info.last_token_usage);
  }
  if (info.total_token_usage && typeof info.total_token_usage === 'object') {
    return codexUsageTotal(info.total_token_usage);
  }
  return null;
}

/**
 * Invoke `onRecord` for every parseable JSONL record in `raw`. Blank lines and
 * lines that fail to parse are skipped silently — the shared line-scan both
 * runtime legs walk (so a single bad line never aborts the read).
 *
 * @param {string} raw transcript text (whole file or a tail slice)
 * @param {(record: object) => void} onRecord
 */
function forEachRecord(raw, onRecord) {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    onRecord(record);
  }
}

/**
 * Claude / unknown leg: the CURRENT occupancy is the LAST `usage` block in the
 * transcript (the most recent turn), NOT the sum across turns. Claude
 * transcripts carry no window, so `contextWindow` is 0 (the caller applies its
 * default / env override).
 *
 * @param {string} raw transcript text (whole file or a tail slice)
 * @returns {{tokens:number, contextWindow:number}}
 */
function readClaudeContextUsage(raw) {
  let tokens = 0;
  forEachRecord(raw, (record) => {
    const block = extractUsageBlock(record);
    if (block) tokens = sumUsageBlock(block);
  });
  return { tokens, contextWindow: 0 };
}

/**
 * Codex leg: the CURRENT occupancy is the LAST `token_count` snapshot's
 * `last_token_usage` (the most recent turn), and its `model_context_window` is
 * the real context limit. Non-`token_count` records are skipped; an absent
 * snapshot degrades to 0.
 *
 * @param {string} raw transcript text (whole file or a tail slice)
 * @returns {{tokens:number, contextWindow:number}}
 */
function readCodexContextUsage(raw) {
  let tokens = 0;
  let contextWindow = 0;
  forEachRecord(raw, (record) => {
    if (!isCodexTokenCount(record)) return;
    const info = record.payload.info;
    const occupancy = codexTurnOccupancy(info);
    if (occupancy !== null) tokens = occupancy;
    const window = toTokenCount(info && info.model_context_window);
    if (window > 0) contextWindow = window;
  });
  return { tokens, contextWindow };
}

/**
 * Read up to `TAIL_BYTES` from the END of the transcript. Returns the raw slice
 * and whether it covers the whole file (`complete`). The boundary line of a
 * partial slice is a mid-record fragment that fails to parse and is skipped —
 * harmless, since the last-turn occupancy lives at the very end. May throw
 * (ENOENT etc.); the caller wraps it in fail-open handling.
 *
 * @param {string} transcriptPath
 * @returns {{raw:string, complete:boolean}}
 */
function readTranscriptTail(transcriptPath) {
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = size > TAIL_BYTES ? size - TAIL_BYTES : 0;
    const length = size - start;
    const buf = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buf, read, length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return { raw: buf.toString('utf8', 0, read), complete: start === 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Read the transcript at `transcriptPath` and return the CURRENT context
 * occupancy `{ tokens, contextWindow }`. Branches on the sniffed runtime format
 * (see the module header): both legs take the most recent turn, not a sum. Only
 * the transcript tail is scanned; a partial tail with no usage falls back to a
 * full read. Returns `{ tokens: 0, contextWindow: 0 }` for a missing / empty /
 * unreadable transcript, and skips malformed lines — never throws.
 *
 * @param {string|undefined|null} transcriptPath path to the transcript JSONL
 * @returns {{tokens:number, contextWindow:number}}
 */
function readContextUsage(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return emptyUsage();
  try {
    // Consult the shared sniff read-only; it selects the occupancy strategy.
    const format = sniffFormat(transcriptPath);
    const parse = format === 'codex' ? readCodexContextUsage : readClaudeContextUsage;
    const tail = readTranscriptTail(transcriptPath);
    const result = parse(tail.raw);
    // A bounded tail that found nothing MIGHT have sliced off the only usage
    // line — fall back to a full read before giving up.
    if (result.tokens > 0 || tail.complete) return result;
    return parse(fs.readFileSync(transcriptPath, 'utf8'));
  } catch {
    return emptyUsage();
  }
}

/**
 * Back-compat numeric accessor: the current context occupancy, in tokens, of
 * the transcript at `transcriptPath` (see `readContextUsage`). Returns 0 for a
 * missing / empty / unreadable transcript.
 *
 * @param {string|undefined|null} transcriptPath
 * @returns {number} current context tokens (>= 0)
 */
function readCumulativeUsage(transcriptPath) {
  return readContextUsage(transcriptPath).tokens;
}

module.exports = {
  readContextUsage,
  readCumulativeUsage,
  USAGE_TOKEN_FIELDS,
};
