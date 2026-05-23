'use strict';

/**
 * `duplicate-blocks` rule.
 *
 * Cross-file rule. Detects identical token windows of length >= `defaultThreshold`
 * (50) shared between any two files in the input batch.
 *
 * Tokenization: splits source on any run of non-word/non-symbol whitespace.
 * Hashing: rolling SHA-1 of a fixed-size token window (joined by single space)
 * for cheap equality comparison across files.
 *
 * Public surface:
 *   { id, defaultThreshold, checkAll(files: Array<{path, source}>) -> Violation[] }
 *
 * Each violation has shape:
 *   { rule: 'duplicate-blocks', file, line, message }
 * `line` is the 1-based line where the duplicate window starts in `file`.
 * `message` includes the token count and the paired file:line.
 */

const crypto = require('node:crypto');

const DEFAULT_THRESHOLD = 50;
const EXCLUDED_PATTERN = /(\.test\.js|\.spec\.js|\.md)$/i;

function isExcluded(filePath) {
  return EXCLUDED_PATTERN.test(filePath);
}

/**
 * Tokenize source into { tokens: string[], lines: number[] }.
 * `lines[i]` is the 1-based line number where `tokens[i]` begins.
 * Splits on whitespace runs.
 */
function tokenize(source) {
  const tokens = [];
  const lines = [];
  if (!source) return { tokens, lines };
  let line = 1;
  let i = 0;
  const len = source.length;
  while (i < len) {
    const ch = source[i];
    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    // Read a token: run of non-whitespace
    let j = i;
    while (j < len && !/\s/.test(source[j])) j += 1;
    tokens.push(source.slice(i, j));
    lines.push(line);
    i = j;
  }
  return { tokens, lines };
}

function hashWindow(tokens, start, windowSize) {
  const slice = tokens.slice(start, start + windowSize).join(' ');
  return crypto.createHash('sha1').update(slice).digest('hex');
}

/**
 * Given two equal-length token spans known to match starting at (aStart, bStart),
 * return how many additional tokens match contiguously to the left and right.
 */
function extendMatch(aTokens, aStart, bTokens, bStart, windowSize) {
  let left = 0;
  while (
    aStart - left - 1 >= 0 &&
    bStart - left - 1 >= 0 &&
    aTokens[aStart - left - 1] === bTokens[bStart - left - 1]
  ) {
    left += 1;
  }
  let right = 0;
  while (
    aStart + windowSize + right < aTokens.length &&
    bStart + windowSize + right < bTokens.length &&
    aTokens[aStart + windowSize + right] === bTokens[bStart + windowSize + right]
  ) {
    right += 1;
  }
  return { left, right };
}

/**
 * Build a map from window-hash to first occurrence { fileIndex, tokenIndex }.
 * For each subsequent occurrence in a different file, emit a violation pair.
 */
function checkAll(files, options) {
  const list = files || [];
  const windowSize = options && options.threshold ? options.threshold : DEFAULT_THRESHOLD;
  const violations = [];

  // Pre-tokenize each file (skip excluded).
  const docs = list.map((f) => {
    if (!f || typeof f.path !== 'string' || isExcluded(f.path)) {
      return { path: f && f.path, tokens: [], lines: [] };
    }
    const { tokens, lines } = tokenize(f.source || '');
    return { path: f.path, tokens, lines };
  });

  // hash -> first { docIndex, tokenIndex }
  const seen = new Map();
  // Track emitted pairs to avoid duplicates (one violation per file in a pair, max once per pair).
  const emittedPairs = new Set();

  for (let d = 0; d < docs.length; d += 1) {
    const { tokens, lines, path: docPath } = docs[d];
    if (tokens.length < windowSize) continue;
    for (let t = 0; t <= tokens.length - windowSize; t += 1) {
      const h = hashWindow(tokens, t, windowSize);
      const prior = seen.get(h);
      if (!prior) {
        seen.set(h, { docIndex: d, tokenIndex: t });
        continue;
      }
      if (prior.docIndex === d) {
        // intra-file duplicate — not the cross-file scope of this rule
        continue;
      }
      const pairKey = `${prior.docIndex}|${d}`;
      if (emittedPairs.has(pairKey)) continue;
      emittedPairs.add(pairKey);

      const priorDoc = docs[prior.docIndex];

      // Extend the match in both directions to capture the true block length.
      const { left, right } = extendMatch(
        priorDoc.tokens,
        prior.tokenIndex,
        tokens,
        t,
        windowSize,
      );
      const blockTokens = windowSize + left + right;
      const priorStart = prior.tokenIndex - left;
      const thisStart = t - left;
      const priorLine = priorDoc.lines[priorStart] || 1;
      const thisLine = lines[thisStart] || 1;

      violations.push({
        rule: 'duplicate-blocks',
        file: priorDoc.path,
        line: priorLine,
        message: `duplicate code block (${blockTokens} tokens) shared with ${docPath}:${thisLine}`,
      });
      violations.push({
        rule: 'duplicate-blocks',
        file: docPath,
        line: thisLine,
        message: `duplicate code block (${blockTokens} tokens) shared with ${priorDoc.path}:${priorLine}`,
      });
    }
  }

  return violations;
}

/**
 * Per-file `check` is preserved for engine compatibility but is a no-op:
 * this rule operates on the whole batch via `checkAll`.
 */
function check(_filePath, _source) {
  return [];
}

module.exports = {
  id: 'duplicate-blocks',
  defaultThreshold: DEFAULT_THRESHOLD,
  check,
  checkAll,
};
