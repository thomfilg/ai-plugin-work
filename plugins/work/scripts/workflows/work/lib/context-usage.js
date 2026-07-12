'use strict';

/**
 * context-usage.js
 *
 * Cumulative context-token reader for the `/work` context-window monitor
 * (GH-313, Task 2). Reads the session's own transcript JSONL and sums the
 * per-turn `usage` token fields (`input_tokens` + `output_tokens`, plus the
 * cache token fields when present) into a single cumulative count.
 *
 * Fail-safe by contract: a missing / empty / unreadable transcript, or a
 * corrupt JSONL line, degrades to a safe `0` — it never throws — so the
 * fail-open PostToolUse caller can no-op. Zero runtime dependencies, CommonJS.
 *
 * `sniffFormat` (from the shared runtime transcript facade) is consulted
 * READ-ONLY for claude/codex format detection; no sibling-owned file is
 * modified.
 */

const fs = require('node:fs');
const { sniffFormat } = require('../../lib/runtime/transcript');

/** Per-turn `usage` token fields summed into the cumulative total. */
const USAGE_TOKEN_FIELDS = Object.freeze([
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
]);

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
 * Read the transcript at `transcriptPath` and return the cumulative token
 * count summed across every per-turn `usage` block. Returns 0 for a missing,
 * empty, or unreadable transcript, and skips malformed lines — never throws.
 *
 * `sniffFormat` is consulted read-only for format detection (claude/codex);
 * an `unknown` format still reads (the JSONL/`usage`-block shape is the same
 * across both legs), so the sniff is advisory and does not short-circuit.
 *
 * @param {string|undefined|null} transcriptPath path to the transcript JSONL
 * @returns {number} cumulative context tokens (>= 0)
 */
function readCumulativeUsage(transcriptPath) {
  if (typeof transcriptPath !== 'string' || transcriptPath === '') return 0;
  let raw;
  try {
    // Consult the shared sniff read-only; a read error here degrades to 0.
    sniffFormat(transcriptPath);
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return 0;
  }
  let total = 0;
  for (const line of raw.split(/\r?\n/)) {
    total += tokensFromLine(line);
  }
  return total;
}

module.exports = {
  readCumulativeUsage,
  USAGE_TOKEN_FIELDS,
};
