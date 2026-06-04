/**
 * Phase: reuse_audit_enforcement.
 *
 * GH-282 Task 4. Reads `## Reuse Audit` entries from spec.md (via Task 2's
 * `readReuseAudit`) and verifies each MUST-reuse symbol appears in the
 * content of at least one changed file. On miss, scans the same diff for
 * tokens sharing the symbol's trailing suffix (e.g. `*Toolbar`) and surfaces
 * a "did you mean to extend X?" hint in the failure record's `observed`.
 *
 * Fail-closed: any thrown parser/IO error becomes `{ ok: false, errors: [...] }`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const { COMPLETION_PHASES } = require('../../completion-phase-registry');
const { readReuseAudit, readChangedFiles } = require('../kind-checks/shared');
const { makeFailure } = require('../failure-record');
const { appendForCheckType } = require('../failure-store');
const { escapeRegex } = require('../../../lib/parse-completion-status');
const config = require('../../../lib/config');

const SUFFIX_RE = /([A-Z][a-z0-9]+)$/;

/**
 * Extract candidate tokens from `diffContent` that share `symbol`'s
 * trailing PascalCase suffix (e.g. for `ContentPageToolbar`, the suffix
 * is `Toolbar`; matches like `ExploreBulkToolbar` are returned).
 *
 * Pure function for testability/readability.
 *
 * @param {string} symbol
 * @param {string} diffContent
 * @returns {string[]}
 */
function extractSuffixCandidates(symbol, diffContent) {
  if (!/^[A-Z]/.test(symbol)) return [];
  const m = SUFFIX_RE.exec(symbol);
  if (!m) return [];
  const suffix = m[1];
  const re = new RegExp(`\\b\\w+${escapeRegex(suffix)}\\b`, 'g');
  const out = new Set();
  let hit;
  while ((hit = re.exec(diffContent)) !== null) {
    if (hit[0] !== symbol) out.add(hit[0]);
  }
  return Array.from(out);
}

function readFileSafe(abs) {
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch {
    return '';
  }
}

function loadChangedContents(ctx, changed) {
  const root = ctx.worktreeRoot || process.cwd();
  const out = [];
  for (const rel of changed) {
    const abs = path.isAbsolute(rel) ? rel : path.join(root, rel);
    out.push({ rel, content: readFileSafe(abs) });
  }
  return out;
}

function extractAddedLines(diffOutput) {
  // Keep only lines starting with `+` but not `+++` (file header).
  const adds = [];
  for (const line of (diffOutput || '').split('\n')) {
    if (line.startsWith('+++')) continue;
    if (line.startsWith('+')) adds.push(line.slice(1));
  }
  return adds.join('\n');
}

// B3 fix: extract just the added-line text from `git diff -U0` output so
// reuse checks only count lines this PR actually added. Comments, unchanged
// imports, and incidental mentions in untouched code no longer pass the gate.
//
// Scoped to `changedFiles` (from readChangedFiles / pr-context.json) so a
// symbol that appears only on added lines of an out-of-list file cannot
// satisfy the reuse audit — review feedback: an unscoped repo-wide scan let
// stray matches in unrelated files pass the gate.
//
// Return convention (review feedback):
//   - string (possibly empty) → git ran successfully; result is authoritative.
//     An empty string means "PR added zero lines in the scoped files" and
//     must NOT fall back to the proxy — otherwise a deletion-only PR could
//     pass MUST-reuse via pre-existing code.
//   - null                    → git could not run (no candidate base or
//     every spawn errored). Callers fall back to the full-content proxy so
//     we don't fail-closed on missing tooling.
// `changedFiles` empty short-circuits to '' (success, nothing added).
function readAddedLines(ctx, changedFiles) {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return '';
  const root = ctx.worktreeRoot || process.cwd();
  for (const base of config.getDiffBaseCandidates({ cwd: root })) {
    const r = childProcess.spawnSync(
      'git',
      ['diff', '-U0', `${base}...HEAD`, '--', ...changedFiles],
      { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
    );
    if (r && r.status === 0) return extractAddedLines(r.stdout);
  }
  return null;
}

// Strict check (B3): the symbol must appear in lines the PR added — not in
// pre-existing code. Distinguishes git-failure (null input → caller falls
// back) from git-success-with-empty-diff (string input → strict result,
// even if the string is empty).
function symbolPresentInAdded(symbol, addedLines) {
  if (addedLines === null || addedLines === undefined) return null;
  if (addedLines === '') return false;
  const re = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
  return re.test(addedLines);
}

function symbolPresentInBlobs(symbol, fileBlobs) {
  const re = new RegExp(`\\b${escapeRegex(symbol)}\\b`);
  return fileBlobs.some((f) => re.test(f.content));
}

function errMessage(err) {
  return err && err.message ? err.message : String(err);
}

function buildMissingFailure(entry, joined) {
  const symbol = entry.symbol;
  const candidates = extractSuffixCandidates(symbol, joined);
  const observed =
    candidates.length > 0
      ? `found ${candidates[0]} in diff — did you mean to extend ${symbol}?`
      : `${symbol} not found in diff — imported instead by no changed file`;
  return makeFailure({
    // requirementId is synthesized by readReuseAudit() as `REUSE-<n>` so each
    // MUST-reuse entry has a stable, self-evident identifier rather than the
    // misleading 'R1' default that ignored the underlying requirement.
    requirementId: entry.requirementId,
    checkType: 'reuse_audit',
    expected: `${symbol} imported`,
    observed,
    file: undefined,
    line: entry.line,
  });
}

function checkMustReuseEntries(entries, blobs, joined, addedLines, failures) {
  let mustChecked = 0;
  let mustMissing = 0;
  for (const entry of entries) {
    if (!entry || entry.mustReuse !== true) continue;
    mustChecked += 1;
    // Prefer added-line match (B3). If git was unavailable, fall back to the
    // legacy full-content proxy so we don't fail-closed on missing tooling.
    const addedHit = symbolPresentInAdded(entry.symbol, addedLines);
    const present = addedHit === null ? symbolPresentInBlobs(entry.symbol, blobs) : addedHit;
    if (present) continue;
    mustMissing += 1;
    failures.push(buildMissingFailure(entry, joined));
  }
  return { mustChecked, mustMissing };
}

function recordParserFailure(ctx, failures, err) {
  // Surface parser errors through the failure-store so report.js can include
  // them in completion-verdict.json instead of only echoing the error in the
  // phase summary.
  const record = makeFailure({
    requirementId: 'REUSE-PARSER',
    checkType: 'reuse_audit',
    expected: 'parseable ## Reuse Audit section',
    observed: errMessage(err),
  });
  failures.push(record);
  try {
    appendForCheckType(ctx.tasksDir, 'reuse_audit', [record], { reuseChecked: 0 });
  } catch {
    /* hook-gated; persistence is best-effort */
  }
}

// Synchronous — phase runner calls `handler.validate(ctx)` without await,
// so an `async` declaration would return a Promise that `advancePhase`
// cannot read `ok`/`errors` from, silently neutering enforcement.
function validate(ctx) {
  const failures = ctx.failures || (ctx.failures = []);
  const startLen = failures.length;
  let entries;
  try {
    entries = readReuseAudit(ctx.tasksDir);
  } catch (err) {
    recordParserFailure(ctx, failures, err);
    return {
      ok: false,
      errors: [`parser threw: ${errMessage(err)}`],
      summary: 'reuse audit parser error (fail-closed)',
    };
  }

  if (entries === null) {
    appendForCheckType(ctx.tasksDir, 'reuse_audit', [], { reuseChecked: 0 });
    return { ok: true, summary: 'no Reuse Audit section — skipped' };
  }

  try {
    const changed = readChangedFiles(ctx) || [];
    const blobs = loadChangedContents(ctx, changed);
    const joined = blobs.map((b) => b.content).join('\n');
    const addedLines = readAddedLines(ctx, changed);
    const { mustChecked, mustMissing } = checkMustReuseEntries(
      entries,
      blobs,
      joined,
      addedLines,
      failures
    );
    ctx.reuseAuditChecked = mustChecked;
    appendForCheckType(ctx.tasksDir, 'reuse_audit', failures.slice(startLen), {
      reuseChecked: mustChecked,
    });

    if (mustMissing > 0) {
      return {
        ok: false,
        errors: [`${mustMissing} MUST-reuse symbol(s) missing from diff`],
        summary: `reuse audit: ${mustChecked} checked, ${mustMissing} missing`,
      };
    }
    return {
      ok: true,
      summary: `reuse audit: ${mustChecked} checked, 0 missing`,
    };
  } catch (err) {
    return {
      ok: false,
      errors: [`parser threw: ${errMessage(err)}`],
      summary: 'reuse audit phase error (fail-closed)',
    };
  }
}

function instructions() {
  return '';
}

module.exports = function register(registerPhase) {
  registerPhase(COMPLETION_PHASES.reuse_audit_enforcement, {
    next: COMPLETION_PHASES.suggested_scope_enforcement,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.extractSuffixCandidates = extractSuffixCandidates;
module.exports.symbolPresentInAdded = symbolPresentInAdded;
module.exports.symbolPresentInBlobs = symbolPresentInBlobs;
