/**
 * Phase: suggested_scope_enforcement.
 *
 * GH-282 Task 5. Reads `### Files in scope` / `### Suggested Scope` entries
 * from tasks.md (via Task 2's `readSuggestedScopeFiles`) and verifies each
 * declared file appears in the changed-file set AND has non-empty diff hunks
 * (`git diff --numstat`).
 *
 * Fail-closed: any thrown parser/IO error becomes `{ ok: false, errors: [...] }`.
 */

'use strict';

const childProcess = require('node:child_process');

const { COMPLETION_PHASES } = require('../../completion-phase-registry');
const { readSuggestedScopeFiles, readChangedFiles } = require('../kind-checks/shared');
const { makeFailure } = require('../failure-record');
const { appendForCheckType } = require('../failure-store');
const config = require('../../../lib/config');

/**
 * Decide whether a single `git diff --numstat` row represents a non-empty
 * hunk. `adds`/`dels` may be `-` for binary files (treated as a hunk).
 *
 * @param {string} adds
 * @param {string} dels
 * @returns {boolean}
 */
function numstatRowHasHunk(adds, dels) {
  if (adds === '-' || dels === '-') return true;
  const a = Number(adds);
  const d = Number(dels);
  const aPos = Number.isFinite(a) && a > 0;
  const dPos = Number.isFinite(d) && d > 0;
  return aPos || dPos;
}

/**
 * Expand a `git diff --numstat` path field into the set of paths it
 * represents. Renames take two forms:
 *   - `old/path => new/path`
 *   - `prefix/{old => new}/suffix`  (brace-style for shared prefixes)
 *
 * Returns both the old and new path so a scoped file that was renamed in
 * this PR still matches (review feedback): `hasNonEmptyHunk` previously
 * required an exact string match and silently treated renamed scoped files
 * as unchanged.
 *
 * @param {string} raw
 * @returns {string[]}
 */
function expandNumstatPath(raw) {
  const p = (raw || '').trim();
  if (!p) return [];
  const brace = p.match(/^(.*)\{([^{}]*?)\s*=>\s*([^{}]*?)\}(.*)$/);
  if (brace) {
    const [, prefix, oldPart, newPart, suffix] = brace;
    const join = (mid) => `${prefix}${mid}${suffix}`.replace(/\/{2,}/g, '/').replace(/\/$/, '');
    return [join(oldPart.trim()), join(newPart.trim())];
  }
  const arrow = p.match(/^(.+?)\s*=>\s*(.+)$/);
  if (arrow) return [arrow[1].trim(), arrow[2].trim()];
  return [p];
}

/**
 * Parse `git diff --numstat` output and decide whether `file` has any
 * non-empty hunks. Each numstat line has the shape `<adds>\t<dels>\t<path>`.
 * Renamed paths are recognized via `expandNumstatPath` so a rename of the
 * scoped file is treated as a change.
 *
 * @param {string} file
 * @param {string} numstatOutput
 * @returns {boolean}
 */
function hasNonEmptyHunk(file, numstatOutput) {
  if (!file || !numstatOutput) return false;
  for (const line of numstatOutput.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [adds, dels, p] = parts;
    if (!expandNumstatPath(p).includes(file)) continue;
    return numstatRowHasHunk(adds, dels);
  }
  return false;
}

/**
 * Run `git diff --numstat` against each candidate base. Returns
 * `{ ok: true, output }` on the first successful invocation, or
 * `{ ok: false, error }` when every candidate failed. Distinguishing the two
 * (B6) keeps the failure message accurate: "git failed" vs "in diff but
 * unchanged content".
 */
function runNumstat(ctx) {
  const root = ctx.worktreeRoot || process.cwd();
  let lastErr = 'no diff base candidates available';
  for (const base of config.getDiffBaseCandidates({ cwd: root })) {
    const r = childProcess.spawnSync('git', ['diff', '--numstat', `${base}...HEAD`], {
      cwd: root,
      encoding: 'utf8',
    });
    if (r && r.status === 0) return { ok: true, output: r.stdout || '' };
    if (r) {
      const stderr = (r.stderr || '').trim();
      lastErr = stderr || `git diff exited ${r.status} against base ${base}`;
    }
  }
  return { ok: false, error: lastErr };
}

function errMessage(err) {
  return err && err.message ? err.message : String(err);
}

function scopeFailure(file, observed) {
  return makeFailure({
    requirementId: 'R2',
    checkType: 'suggested_scope',
    expected: `${file} in diff`,
    observed,
    file,
  });
}

function evaluateScopedFile(file, changedSet, numstat) {
  if (!changedSet.has(file)) {
    return scopeFailure(file, 'missing from git diff --name-only');
  }
  if (!hasNonEmptyHunk(file, numstat)) {
    return scopeFailure(file, 'in diff but unchanged content');
  }
  return null;
}

function checkScopedFiles(scopedFiles, changedSet, numstat, failures) {
  let missing = 0;
  for (const file of scopedFiles) {
    const fail = evaluateScopedFile(file, changedSet, numstat);
    if (fail) {
      missing += 1;
      failures.push(fail);
    }
  }
  return missing;
}

// Synchronous — see note in reuse_audit_enforcement.js.
function validate(ctx) {
  const failures = ctx.failures || (ctx.failures = []);
  const startLen = failures.length;
  let scopedFiles;
  try {
    scopedFiles = readSuggestedScopeFiles(ctx.tasksDir);
  } catch (err) {
    return {
      ok: false,
      errors: [`parser threw: ${errMessage(err)}`],
      summary: 'suggested scope parser error (fail-closed)',
    };
  }

  if (scopedFiles === null) {
    appendForCheckType(ctx.tasksDir, 'suggested_scope', [], { scopeChecked: 0 });
    return { ok: true, summary: 'no Suggested Scope section — skipped' };
  }

  try {
    const changed = readChangedFiles(ctx) || [];
    const changedSet = new Set(changed);
    const numstatResult = runNumstat(ctx);
    if (!numstatResult.ok) {
      // B6: surface git failure explicitly instead of masquerading as "every
      // scoped file has unchanged content".
      return {
        ok: false,
        errors: [`git diff --numstat failed: ${numstatResult.error}`],
        summary: 'suggested scope: git numstat failed (fail-closed)',
      };
    }
    const numstat = numstatResult.output;
    const missing = checkScopedFiles(scopedFiles, changedSet, numstat, failures);
    ctx.scopeChecked = scopedFiles.length;
    appendForCheckType(ctx.tasksDir, 'suggested_scope', failures.slice(startLen), {
      scopeChecked: scopedFiles.length,
    });

    if (missing > 0) {
      return {
        ok: false,
        errors: [`${missing} Suggested Scope file(s) missing from diff`],
        summary: `suggested scope: ${scopedFiles.length} checked, ${missing} missing`,
        scopeChecked: scopedFiles.length,
      };
    }
    return {
      ok: true,
      summary: `suggested scope: ${scopedFiles.length} checked, 0 missing`,
      scopeChecked: scopedFiles.length,
    };
  } catch (err) {
    return {
      ok: false,
      errors: [`parser threw: ${errMessage(err)}`],
      summary: 'suggested scope phase error (fail-closed)',
    };
  }
}

function instructions() {
  return '';
}

module.exports = function register(registerPhase) {
  registerPhase(COMPLETION_PHASES.suggested_scope_enforcement, {
    next: COMPLETION_PHASES.test_pass_crossref,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.hasNonEmptyHunk = hasNonEmptyHunk;
module.exports.expandNumstatPath = expandNumstatPath;
