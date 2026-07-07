/**
 * task-scope-write-targets.js
 *
 * Write-target extraction for the protect-task-scope hook (Gate D): which
 * paths does a tool call try to write? Covers direct file tools, codex
 * apply_patch payloads, and a subset of Bash write vectors (redirects, tee,
 * cp/mv targets — see createFileProtector in protect-state-files for the
 * full vector set; this hook fails open and that protector still catches
 * real bypass attempts).
 */

'use strict';

const path = require('path');

// Vendored dual-runtime adapter: codex apply_patch payloads carry a raw patch
// (no file_path); parseApplyPatch extracts the touched paths from its headers.
const { parseApplyPatch } = require(path.join(__dirname, '..', '..', 'lib', 'runtime', 'tools'));

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Parsed apply_patch write targets (paths as written in the patch headers —
 * decideEdit relativizes against workDir the same way it does for Bash
 * targets). Unparseable targets (ok:false) are dropped: Gate D is an
 * advisory scope gate and fails open on them (C6).
 */
function extractApplyPatchWriteTargets(toolInput) {
  return parseApplyPatch(toolInput?.command)
    .filter((t) => t.ok && t.path)
    .map((t) => t.path);
}

// ─── Bash command file-path extraction ──────────────────────────────────────

const BASH_WRITE_TOKEN =
  /(?:>>?\s*|tee(?:\s+-a)?\s+|\bof=|\bcp\s+\S+\s+|\bmv\s+\S+\s+)([^\s;|&>]+)/g;

/**
 * Characters that NEVER appear in a real file path but DO appear in shell
 * expressions, JS arrow functions, comparison operators, etc. If a captured
 * "token" contains any of these, it is not a filename — it's syntax bleed-
 * through from quoted code like `node -e "x=>y"` or `bash -c "test a > b"`.
 *
 * This prevents the gate from blocking commands whose inline interpreter
 * code happens to contain `>` (arrow functions, comparators, redirects
 * inside quoted strings).
 */
const NON_PATH_CHAR = /[()=+{}[\]<>$`!*?]/;

function looksLikePath(token) {
  if (!token) return false;
  if (NON_PATH_CHAR.test(token)) return false;
  // Reject pure-numeric tokens (file descriptors after redirects like `2>&1`
  // get caught here even though `>` is excluded above) and dot/dotdot.
  if (/^\d+$/.test(token)) return false;
  if (token === '.' || token === '..') return false;
  return true;
}

/**
 * Strip the body of single- and double-quoted strings before scanning so
 * shell operators inside `"..."` or `'...'` don't trigger false positives.
 * This is intentionally approximate (no shell escape handling, no `$(...)`
 * nesting) — the hook fails open and the protect-state-files protector
 * still catches real bypass attempts via Vector 2/3/4.
 */
function stripQuotedStrings(cmd) {
  return String(cmd || '')
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function extractBashWriteTargets(cmd) {
  if (!cmd || typeof cmd !== 'string') return [];
  const out = new Set();
  const scanCmd = stripQuotedStrings(cmd);
  BASH_WRITE_TOKEN.lastIndex = 0;
  let m;
  while ((m = BASH_WRITE_TOKEN.exec(scanCmd)) !== null) {
    const tok = (m[1] || '').replace(/^["']|["']$/g, '');
    if (!tok || tok.startsWith('-')) continue;
    if (!looksLikePath(tok)) continue;
    out.add(tok);
  }
  return Array.from(out);
}

/**
 * Best-effort extraction of the primary write target for an audit log row.
 * Returns the first plausible path, or empty string.
 */
function extractTargetPath(toolName, toolInput) {
  if (FILE_WRITE_TOOLS.has(toolName)) {
    return (toolInput && toolInput.file_path) || '';
  }
  if (toolName === 'apply_patch') {
    return extractApplyPatchWriteTargets(toolInput)[0] || '';
  }
  if (toolName === 'Bash') {
    const cmd = toolInput && toolInput.command;
    if (!cmd) return '';
    const targets = extractBashWriteTargets(String(cmd));
    return targets[0] || '';
  }
  return '';
}

module.exports = {
  FILE_WRITE_TOOLS,
  extractApplyPatchWriteTargets,
  extractBashWriteTargets,
  extractTargetPath,
};
