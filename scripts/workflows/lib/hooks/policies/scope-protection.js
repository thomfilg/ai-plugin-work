/**
 * scope-protection.js
 *
 * Pure decision functions for Gate D — the implement-time file-edit hook.
 *
 * Given the active task's `filesInScope` and `filesOutOfScope` glob lists,
 * decide whether a tool's target path should be allowed or blocked.
 *
 * Decision rules (in order):
 *   1. If filePath matches ANY `filesOutOfScope` glob → BLOCK ("sibling-owned").
 *   2. If filePath matches ANY `filesInScope` glob → ALLOW.
 *   3. Otherwise → BLOCK ("outside declared scope").
 *
 * Files outside the worktree root (`workDir`) are NEVER blocked by this
 * policy — they fall under other hooks (protect-orchestrator-state etc.).
 *
 * Globs supported:
 *   - `**`  matches any number of path segments (including `/`)
 *   - `*`   matches any sequence within a single path segment
 *   - `?`   matches a single character (not `/`)
 *   - exact paths match exactly
 *   - trailing `/` is normalized away
 *
 * Patterns are matched against the path RELATIVE to `workDir`, normalized to
 * forward slashes.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Walk up from `p` to the first existing ancestor, realpath it, then re-join
 * the non-existent tail. Lets us defend against symlink-escape attempts on
 * write targets that do not yet exist (e.g. Write into a new file under a
 * directory that itself is a symlink).
 *
 * @param {string} p absolute path
 * @returns {string} best-effort canonicalised absolute path
 */
function _realpathBestEffort(p) {
  let current = p;
  const tail = [];
  // Bound to a sane depth so a pathological symlink can't loop us forever.
  for (let i = 0; i < 4096; i++) {
    try {
      const real = fs.realpathSync.native
        ? fs.realpathSync.native(current)
        : fs.realpathSync(current);
      if (tail.length === 0) return real;
      return path.join(real, ...tail.slice().reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return p; // hit filesystem root, give up
      tail.push(path.basename(current));
      current = parent;
    }
  }
  return p;
}

/**
 * True when a posix-style relative path contains a `..` segment anywhere
 * (not just at the start). Defends against `lib/../../../etc/passwd` style
 * post-normalisation traversal — `path.normalize` collapses these on POSIX
 * but a hand-crafted relative input with `\` separators (Windows) can sneak
 * `..` past a naive `startsWith('..')` check.
 *
 * @param {string} rel
 * @returns {boolean}
 */
function _containsParentSegment(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  return rel
    .replace(/\\/g, '/')
    .split('/')
    .some((seg) => seg === '..');
}

/**
 * Compile a glob pattern to a RegExp.
 * Conservative implementation — handles `**`, `*`, `?`, escapes other regex
 * metacharacters. Patterns without globs become exact-match regexes.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegex(glob) {
  const normalized = String(glob || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  let out = '';
  let i = 0;
  while (i < normalized.length) {
    const ch = normalized[i];
    const next = normalized[i + 1];
    if (ch === '*' && next === '*') {
      // `**` — any number of segments
      out += '.*';
      i += 2;
      // Skip a trailing `/` after `**` if present (e.g. `lib/**/foo`)
      if (normalized[i] === '/') i += 1;
      continue;
    }
    if (ch === '*') {
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(ch)) {
      out += '\\' + ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return new RegExp('^' + out + '$');
}

/**
 * Normalize a candidate filePath to a forward-slash path relative to workDir.
 * Returns null when the candidate is OUTSIDE workDir (i.e. should not be
 * subject to scope policy).
 *
 * @param {string} filePath
 * @param {string} workDir
 * @returns {string|null}
 */
function _safeRealpath(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * True when the realpath-resolved candidate escapes the realpath-resolved
 * workDir via a symlink. Returns false when realpath isn't available for
 * workDir (synthetic test inputs) — in that case the caller falls back to
 * the lexical normalisation check.
 */
function _symlinkEscapes(absCandidate, workDir) {
  const realWork = _safeRealpath(workDir);
  if (!realWork) return false;
  const realTarget = _realpathBestEffort(absCandidate);
  const realRel = path.relative(realWork, realTarget);
  if (!realRel) return false;
  return _containsParentSegment(realRel) || path.isAbsolute(realRel);
}

function relativizePath(filePath, workDir) {
  if (!filePath || !workDir) return null;
  // 1. path.normalize the candidate FIRST so a `..` segment can't sneak past
  //    the relative() check via a denormalised input like `lib/./../../etc`.
  const absRaw = path.isAbsolute(filePath) ? filePath : path.resolve(workDir, filePath);
  const abs = path.normalize(absRaw);
  const rel = path.relative(workDir, abs);
  if (!rel || _containsParentSegment(rel) || path.isAbsolute(rel)) return null;
  // 2. Symlink-escape check (extracted to keep complexity bounded).
  if (_symlinkEscapes(abs, workDir)) return null;
  return rel.replace(/\\/g, '/');
}

/**
 * Does any glob in `patterns` match `relPath`?
 * Caches compiled regexes per call.
 *
 * @param {string} relPath
 * @param {string[]} patterns
 * @returns {string|null} matched pattern or null
 */
/**
 * True when the candidate is a safe repo-relative posix path (non-empty
 * string, no `..` segment, not absolute). Extracted so findMatch stays
 * below the complexity threshold.
 */
function _isSafeCandidate(relPath) {
  if (typeof relPath !== 'string' || !relPath) return false;
  if (path.isAbsolute(relPath) || _containsParentSegment(relPath)) return false;
  return true;
}

/**
 * True when a tasks.md glob pattern is safe to use as a scope matcher —
 * non-empty string, not absolute (POSIX or Windows), no `..` segment.
 * Backstop for the parse-time validator in task-scope.js.
 */
function _isSafePattern(p) {
  if (!p || typeof p !== 'string') return false;
  if (path.isAbsolute(p)) return false;
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;
  if (_containsParentSegment(p)) return false;
  return true;
}

function findMatch(relPath, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return null;
  // Defence-in-depth: refuse to match candidates / patterns that slipped
  // through with `..` or absolute paths. relativizePath already rejects
  // these, but findMatch is also called directly (e.g. crossTaskDeps check
  // in protect-task-scope.js) and must not be tricked into widening scope.
  if (!_isSafeCandidate(relPath)) return null;
  for (const p of patterns) {
    if (!_isSafePattern(p)) continue;
    let re;
    try {
      re = globToRegex(p);
    } catch {
      continue;
    }
    if (re.test(relPath)) return p;
  }
  return null;
}

/**
 * @typedef {object} ScopeDecisionInput
 * @property {string} filePath        - The target file path (from tool input).
 * @property {string} workDir         - Worktree / repo root.
 * @property {string[]} filesInScope  - Globs the active task may edit.
 * @property {string[]} filesOutOfScope - Globs the active task must NOT edit.
 * @property {string} [activeTask]    - Human-readable label for the active task.
 *
 * @typedef {object} ScopeDecision
 * @property {boolean} blocked
 * @property {string=} reason
 * @property {string=} match
 * @property {string=} category    - 'sibling-owned' | 'out-of-scope' | 'allow'
 */

/**
 * Decide on a single filePath edit.
 *
 * @param {ScopeDecisionInput} input
 * @returns {ScopeDecision}
 */
function decideEdit(input) {
  const { filePath, workDir, filesInScope, filesOutOfScope, activeTask } = input || {};
  const relPath = relativizePath(filePath, workDir);
  if (relPath === null) {
    // Outside the worktree — not our concern.
    return { blocked: false, category: 'outside-worktree' };
  }

  // GH-392 Task 8 / spec §P0#6 / R7: every block message ends with a `BYPASS:`
  // line advertising the env-var escape hatch + audit log location.
  const bypassLine =
    'BYPASS: set BOTH PROTECT_TASK_SCOPE_BYPASS_REASON="<reason>" AND ' +
    'PROTECT_TASK_SCOPE_BYPASS_TARGET="<exact-rel-path-or-glob>" and retry. ' +
    'Audit: .work-actions.json';

  const outMatch = findMatch(relPath, filesOutOfScope);
  if (outMatch) {
    return {
      blocked: true,
      category: 'sibling-owned',
      match: outMatch,
      reason:
        `BLOCKED: ${relPath} matches \`### Files explicitly out of scope\`` +
        (activeTask ? ` for ${activeTask}` : '') +
        ` (pattern: ${outMatch}). This file is owned by a sibling ticket — do NOT edit it from this ticket.\n` +
        bypassLine,
    };
  }

  const inMatch = findMatch(relPath, filesInScope);
  if (inMatch) {
    return { blocked: false, category: 'allow', match: inMatch };
  }

  return {
    blocked: true,
    category: 'out-of-scope',
    reason:
      `BLOCKED: ${relPath} is outside the active task's \`### Files in scope\`` +
      (activeTask ? ` (${activeTask})` : '') +
      `. If this file genuinely belongs to this task, update tasks.md and re-run /work.\n` +
      bypassLine,
  };
}

module.exports = { decideEdit, globToRegex, relativizePath, findMatch };
