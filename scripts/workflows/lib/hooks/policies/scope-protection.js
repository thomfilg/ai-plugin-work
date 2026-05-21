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

const path = require('path');

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
function relativizePath(filePath, workDir) {
  if (!filePath || !workDir) return null;
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(workDir, filePath);
  const rel = path.relative(workDir, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
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
function findMatch(relPath, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return null;
  for (const p of patterns) {
    if (!p || typeof p !== 'string') continue;
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

  const outMatch = findMatch(relPath, filesOutOfScope);
  if (outMatch) {
    return {
      blocked: true,
      category: 'sibling-owned',
      match: outMatch,
      reason:
        `BLOCKED: ${relPath} matches \`### Files explicitly out of scope\`` +
        (activeTask ? ` for ${activeTask}` : '') +
        ` (pattern: ${outMatch}). This file is owned by a sibling ticket — do NOT edit it from this ticket.`,
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
      `. If this file genuinely belongs to this task, update tasks.md and re-run /work.`,
  };
}

module.exports = { decideEdit, globToRegex, relativizePath, findMatch };
