'use strict';

/**
 * follow-up-pr-verify.js — pure deterministic verification of bot review
 * comments against a unified diff.
 *
 * Tier 1 (deterministic, this module):
 *   - Commented line deleted in the diff  → RESOLVED_BY_CODE_CHANGE
 *   - Commented line rewritten with edit distance ratio ≥ MIN_REWRITE_DISTANCE
 *     (after whitespace normalization)    → RESOLVED_BY_CODE_CHANGE
 * Tier 3 (deterministic, this module):
 *   - Commented line byte-identical at HEAD vs comment.commit_id version
 *                                         → STILL_BLOCKING (no LLM call)
 *
 * Anything in between (line changed but below the rewrite threshold) returns
 * NEEDS_LLM so the caller can optionally route to Tier 2 (LLM verdict, opt-in
 * via FOLLOW_UP_PR_ENABLE_LLM_VERIFY — owned by a follow-up task).
 *
 * Contract:
 *   verifyComment(comment, diff, opts)
 *     comment: { path, line, original_line, commit_id, body, diff_hunk }
 *     diff:    string — unified diff for the PR (or relevant file)
 *     opts:    { llmVerdict?: ({comment,diffHunk}) => 'RESOLVED'|'STILL_EXISTS' }
 *   returns: { disposition: 'RESOLVED_BY_CODE_CHANGE'|'STILL_BLOCKING'|'NEEDS_LLM',
 *              reason: string }
 *   throws:  Error('verifyComment: ...') on malformed input — callers
 *            fail-open by recording STILL_BLOCKING.
 *
 * Spec Q4: rewrite threshold = 0.4 (40%) of normalized old-line length.
 * Zero runtime deps; CommonJS; pure (no I/O).
 */

/** @see spec Q4 — minimum normalized Levenshtein ratio to call a rewrite. */
const MIN_REWRITE_DISTANCE = 0.4;

function normalizeWhitespace(line) {
  if (typeof line !== 'string') return '';
  return line.replace(/\s+/g, ' ').trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const m = a.length;
  const n = b.length;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        curr[j - 1] + 1,
        prev[j] + 1,
        prev[j - 1] + cost
      );
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[n];
}

function assertCommentShape(comment) {
  if (!comment || typeof comment !== 'object') {
    throw new Error('verifyComment: comment must be a non-null object');
  }
  if (typeof comment.path !== 'string' || !comment.path) {
    throw new Error('verifyComment: comment.path must be a non-empty string');
  }
  if (typeof comment.line !== 'number' || !Number.isFinite(comment.line)) {
    throw new Error('verifyComment: comment.line must be a finite number');
  }
}

function assertDiffShape(diff) {
  if (typeof diff !== 'string') {
    throw new Error('verifyComment: diff must be a string');
  }
  // A minimal unified diff must contain at least one hunk header.
  if (!/^@@\s/m.test(diff) && !/^diff --git /m.test(diff)) {
    throw new Error('verifyComment: diff does not look like a unified diff');
  }
}

/**
 * Parse a unified diff into per-file hunks. Returns an array of
 *   { filePath, hunks: [{ oldStart, oldLines, newStart, newLines, lines: [{type, text}] }] }
 * `type` is one of ' ' (context), '-' (removed), '+' (added).
 */
function parseUnifiedDiff(diff) {
  const files = [];
  const lines = diff.split('\n');
  let current = null;
  let hunk = null;
  for (const raw of lines) {
    const gitHeader = raw.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (gitHeader) {
      current = { filePath: gitHeader[2], hunks: [] };
      files.push(current);
      hunk = null;
      continue;
    }
    if (raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('index ')) {
      continue;
    }
    const hh = raw.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hh) {
      if (!current) {
        current = { filePath: null, hunks: [] };
        files.push(current);
      }
      hunk = {
        oldStart: Number(hh[1]),
        oldLines: hh[2] ? Number(hh[2]) : 1,
        newStart: Number(hh[3]),
        newLines: hh[4] ? Number(hh[4]) : 1,
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const tag = raw.charAt(0);
    if (tag === ' ' || tag === '-' || tag === '+') {
      hunk.lines.push({ type: tag, text: raw.slice(1) });
    }
  }
  return files;
}

/**
 * For a given comment (path + line), find the matching file in the diff and
 * return { removed: string[], added: string[], contextAtLine: string|null }.
 * `removed` are lines deleted at or near comment.line, `added` are the
 * corresponding additions, and `contextAtLine` is the unchanged content
 * present at comment.line in the NEW file (or null if the line is gone).
 */
function locateCommentInDiff(comment, parsed) {
  const file = parsed.find((f) => f.filePath === comment.path) || parsed[0];
  if (!file) return { removed: [], added: [], contextAtLine: null, found: false };
  for (const hunk of file.hunks) {
    // Does this hunk cover comment.line in the OLD file?
    const oldEnd = hunk.oldStart + hunk.oldLines - 1;
    const newEnd = hunk.newStart + hunk.newLines - 1;
    const coversOld = comment.line >= hunk.oldStart && comment.line <= oldEnd;
    const coversNew = comment.line >= hunk.newStart && comment.line <= newEnd;
    if (!coversOld && !coversNew) continue;

    const removed = [];
    const added = [];
    let contextAtLine = null;
    let oldCursor = hunk.oldStart;
    let newCursor = hunk.newStart;
    for (const entry of hunk.lines) {
      if (entry.type === ' ') {
        if (newCursor === comment.line) contextAtLine = entry.text;
        oldCursor += 1;
        newCursor += 1;
      } else if (entry.type === '-') {
        if (oldCursor === comment.line || coversOld) removed.push(entry.text);
        oldCursor += 1;
      } else if (entry.type === '+') {
        if (newCursor === comment.line || coversNew) added.push(entry.text);
        newCursor += 1;
      }
    }
    return { removed, added, contextAtLine, found: true };
  }
  return { removed: [], added: [], contextAtLine: null, found: false };
}

function verifyComment(comment, diff, opts) {
  assertCommentShape(comment);
  assertDiffShape(diff);
  const options = opts || {};

  const parsed = parseUnifiedDiff(diff);
  const located = locateCommentInDiff(comment, parsed);

  // Tier 3 — byte-identical (line present unchanged in the diff context for the
  // commented position): no LLM call, stays blocking.
  if (located.contextAtLine !== null && located.removed.length === 0 && located.added.length === 0) {
    return {
      disposition: 'STILL_BLOCKING',
      reason: 'line at comment position is byte-identical between commit and HEAD',
    };
  }

  // Tier 1 — deletion: lines removed at the commented position with no
  // replacement → resolved.
  if (located.removed.length > 0 && located.added.length === 0) {
    return {
      disposition: 'RESOLVED_BY_CODE_CHANGE',
      reason: `line deleted in diff (${located.removed.length} removal(s))`,
    };
  }

  // Tier 1 — rewrite: pair the first removed/added line and compute edit
  // distance ratio on whitespace-normalized strings.
  if (located.removed.length > 0 && located.added.length > 0) {
    const oldNorm = normalizeWhitespace(located.removed[0]);
    const newNorm = normalizeWhitespace(located.added[0]);
    const denom = Math.max(oldNorm.length, newNorm.length, 1);
    const distance = levenshtein(oldNorm, newNorm);
    const ratio = distance / denom;
    if (ratio >= MIN_REWRITE_DISTANCE) {
      return {
        disposition: 'RESOLVED_BY_CODE_CHANGE',
        reason: `line rewritten (levenshtein distance ratio ${ratio.toFixed(2)} ≥ ${MIN_REWRITE_DISTANCE})`,
      };
    }
    // Sub-threshold change — defer to Tier 2/LLM (caller decides).
    return {
      disposition: 'NEEDS_LLM',
      reason: `line changed below rewrite threshold (ratio ${ratio.toFixed(2)} < ${MIN_REWRITE_DISTANCE})`,
    };
  }

  // No hunk covered the commented line — conservative: still blocking.
  // Caller may treat as fail-open.
  return {
    disposition: 'STILL_BLOCKING',
    reason: 'no diff hunk covers the commented line — assumed unchanged',
  };
}

module.exports = { verifyComment };
