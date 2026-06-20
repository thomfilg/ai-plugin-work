'use strict';

/**
 * TriggerTokens — generic primitives over `trigger_prompt` regexes and memory
 * bodies. Consumed by the GH-440 crystallize lint (import-only swap of
 * `extractAlternationTokens`) and the GH-534 `synapsys lint` binary.
 *
 * Five exports:
 *   - extractAlternationTokens(src)  → string[]
 *   - tokenizeBody(body)             → string[]
 *   - triggerMatchesBody(src, body)  → { matchCount, matchedTokens }
 *   - pretoolArgSets(entries)        → { [tool]: Set<argRegexSource> }
 *   - jaccard(a, b)                  → number in [0,1]
 */

const { STOP_WORDS } = require('../lint-stopwords');

// Body matching cap (spec §Security) — slice to first 8 KB before running the
// trigger regex to prevent pathological ReDoS over arbitrarily large bodies.
const BODY_BYTE_CAP = 8 * 1024;

// Body tokenizer regex (spec §Architecture / Task 1 AC) — lowercased word-ish
// tokens of length ≥ 2, hyphen-friendly. Filtered through STOP_WORDS.
const BODY_TOKEN_RE = /\b[a-z0-9][a-z0-9-]{1,}\b/gi;

/**
 * Extract lowercased alternation tokens from a `trigger_prompt` regex source.
 * Picks pipe-separated word-ish tokens inside parenthesised groups, e.g.
 *   `\b(release|version|publish)\b` → ['release','version','publish'].
 * Non-word tokens, single-token groups, and non-string input return [].
 *
 * Byte-identical to the legacy implementation in
 * `synapsys-crystallize-lint.js:34` (preserves R5-overlap behavior).
 *
 * @param {string} triggerPrompt
 * @returns {string[]}
 */
function extractAlternationTokens(triggerPrompt) {
  if (typeof triggerPrompt !== 'string' || triggerPrompt.length === 0) return [];
  const tokens = [];
  const groupRe = /\(([^()]+)\)/g;
  let m;
  while ((m = groupRe.exec(triggerPrompt)) !== null) {
    const inner = m[1];
    if (!inner.includes('|')) continue;
    for (const raw of inner.split('|')) {
      const t = raw.trim();
      if (/^[A-Za-z0-9_-]+$/.test(t)) tokens.push(t.toLowerCase());
    }
  }
  return tokens;
}

/**
 * Tokenize a memory body into lowercased word tokens, filtered through
 * STOP_WORDS. Used by trigger×body match-density scoring.
 *
 * @param {string} body
 * @returns {string[]}
 */
function tokenizeBody(body) {
  if (typeof body !== 'string' || body.length === 0) return [];
  const out = [];
  const re = new RegExp(BODY_TOKEN_RE.source, 'gi');
  let m;
  while ((m = re.exec(body)) !== null) {
    const t = m[0].toLowerCase();
    if (STOP_WORDS.has(t)) continue;
    out.push(t);
  }
  return out;
}

/**
 * Run a `trigger_prompt` regex against a body slice (capped at 8 KB) and
 * return both the match count and the matched token literals. Malformed
 * regexes are swallowed via try/catch → `{ matchCount: 0, matchedTokens: [] }`.
 *
 * @param {string} triggerSource raw regex source from `trigger_prompt`
 * @param {string} body memory body
 * @returns {{ matchCount: number, matchedTokens: string[] }}
 */
function triggerMatchesBody(triggerSource, body) {
  const empty = { matchCount: 0, matchedTokens: [] };
  if (typeof triggerSource !== 'string' || triggerSource.length === 0) return empty;
  if (typeof body !== 'string' || body.length === 0) return empty;
  const capped = body.length > BODY_BYTE_CAP ? body.slice(0, BODY_BYTE_CAP) : body;
  let re;
  try {
    re = new RegExp(triggerSource, 'gi');
  } catch (_) {
    return empty;
  }
  const matchedTokens = [];
  let m;
  while ((m = re.exec(capped)) !== null) {
    matchedTokens.push(m[0]);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return { matchCount: matchedTokens.length, matchedTokens };
}

/**
 * Group `Tool:argRegex` entries by tool name and return a per-tool Set of
 * argument-regex sources. Malformed entries (no colon, empty arg) are skipped.
 *
 * @param {string[]} pretool
 * @returns {Record<string, Set<string>>}
 */
function pretoolArgSets(pretool) {
  const out = {};
  if (!Array.isArray(pretool)) return out;
  for (const entry of pretool) {
    if (typeof entry !== 'string') continue;
    const idx = entry.indexOf(':');
    if (idx <= 0) continue;
    const tool = entry.slice(0, idx);
    const arg = entry.slice(idx + 1);
    if (!arg) continue;
    if (!out[tool]) out[tool] = new Set();
    out[tool].add(arg);
  }
  return out;
}

/**
 * Jaccard similarity: |A ∩ B| / |A ∪ B|. Two empty sets return 0 (avoids
 * NaN division). Accepts Set or array-like input.
 *
 * @param {Set<string> | string[]} setA
 * @param {Set<string> | string[]} setB
 * @returns {number}
 */
function jaccard(setA, setB) {
  const a = setA instanceof Set ? setA : new Set(setA || []);
  const b = setB instanceof Set ? setB : new Set(setB || []);
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

module.exports = {
  extractAlternationTokens,
  tokenizeBody,
  triggerMatchesBody,
  pretoolArgSets,
  jaccard,
};
