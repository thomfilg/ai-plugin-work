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

// GH-607: canonicalize a repo-relative path so spec-declared spellings
// (`./hooks.json`, `foo//bar.json`, a leading `/`) compare equal to git's
// `--name-only` output (repo-relative, no `./`, single separators). Conservative:
// a `..` segment is left intact so an out-of-tree path can't silently normalize
// onto a matching in-tree one.
function normalizeRepoPath(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  let out = p
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  return out.replace(/\/$/, '');
}

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
    // GH-607: key blobs by canonical repo-relative path so `entry.path`
    // (spec-declared spelling) matches regardless of `./` prefix etc.
    out.push({ rel: normalizeRepoPath(rel), content: readFileSafe(abs) });
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

// GH-607: shared word-boundary matcher so `symbolPresentInBlobs` and
// `symbolPresentInBlobsScoped` cannot drift in how they detect a symbol.
function wordBoundaryRe(symbol) {
  return new RegExp(`\\b${escapeRegex(symbol)}\\b`);
}

function symbolPresentInBlobs(symbol, fileBlobs) {
  const re = wordBoundaryRe(symbol);
  return fileBlobs.some((f) => re.test(f.content));
}

// GH-607 (R1): scoped blob check — the symbol must appear in the blob whose
// `rel` matches `relPath`. Used for the P0.1 in-place-extension relaxation so
// a symbol present only in some OTHER modified file cannot satisfy the audit.
function symbolPresentInBlobsScoped(symbol, fileBlobs, relPath) {
  const re = wordBoundaryRe(symbol);
  return fileBlobs.some((f) => f.rel === relPath && re.test(f.content));
}

// GH-607 (R2): non-JS/TS declared paths are treated as config-file entries and
// matched by path/block presence rather than the importable-symbol heuristic.
const JS_TS_EXTENSIONS = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']);

function isConfigPath(p) {
  if (!p || typeof p !== 'string') return false;
  const ext = path.extname(p).toLowerCase();
  if (ext === '') return true; // extensionless (Dockerfile/Makefile/dotfile) → config, not importable
  return !JS_TS_EXTENSIONS.has(ext);
}

// GH-607 (R2): a config-file MUST-reuse entry counts as reused only when its
// declared path is in the change set AND its declared path or symbol block
// literally appears on the added lines of THAT declared file.
//
// Review fix (GH-607): `scopedAddedLines` MUST be `entry.path`'s own added lines
// (callers pass `readAddedLines(ctx, [entry.path])`) — the repo-wide diff let a
// needle in an unrelated changed file satisfy the entry, defeating fail-closed.
function configEntryPresent(entry, scopedAddedLines, changedSet) {
  if (!entry || !entry.path) return false;
  if (!changedSet || !changedSet.has(normalizeRepoPath(entry.path))) return false;
  if (scopedAddedLines === null || scopedAddedLines === undefined || scopedAddedLines === '') {
    return false;
  }
  const needles = [entry.symbol, entry.path].filter((s) => typeof s === 'string' && s.length > 0);
  return needles.some((needle) => new RegExp(escapeRegex(needle)).test(scopedAddedLines));
}

function errMessage(err) {
  return err && err.message ? err.message : String(err);
}

// GH-607 (R5/P1.1): distinguish the two miss classes when there is no
// suffix-candidate "did you mean to extend X?" hint — a symbol whose declaring
// file exists on disk with the symbol but was NOT modified in this change
// ("unmodified file") vs a symbol no changed file references at all.
function missClassMessage(symbol, declaredInUnmodifiedFile) {
  return declaredInUnmodifiedFile
    ? `${symbol} not found in diff — declared in an unmodified file (not reused here)`
    : `${symbol} not found in diff — no changed file references it`;
}

// GH-607 (R5): the symbol's declaring file exists on disk and contains the
// symbol, yet that file was NOT modified in this change (not in `changedSet`).
// This is the "declared in an unmodified file" miss class.
function declaredInUnmodifiedFile(ctx, entry, changedSet) {
  if (!entry.path) return false;
  if (changedSet && changedSet.has(normalizeRepoPath(entry.path))) return false;
  const root = ctx.worktreeRoot || process.cwd();
  const abs = path.isAbsolute(entry.path) ? entry.path : path.join(root, entry.path);
  const content = readFileSafe(abs);
  return content !== '' && wordBoundaryRe(entry.symbol).test(content);
}

function buildMissingFailure(entry, joined, declaredElsewhere) {
  const symbol = entry.symbol;
  const candidates = extractSuffixCandidates(symbol, joined);
  const observed =
    candidates.length > 0
      ? `found ${candidates[0]} in diff — did you mean to extend ${symbol}?`
      : missClassMessage(symbol, declaredElsewhere);
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

// GH-607: does the declaring file for `entry` appear in the change set with
// non-empty content? Gate for the P0.1 in-place-extension relaxation and for
// the refined "unmodified file" miss message.
function declaringFileModified(entry, changedSet, blobs) {
  if (!entry.path || !changedSet) return false;
  const norm = normalizeRepoPath(entry.path);
  if (!changedSet.has(norm)) return false;
  return blobs.some((b) => b.rel === norm && b.content !== '');
}

// GH-607 (R1/P0.1): in-place extension — the symbol is not on an added line,
// but its declaring file WAS modified in this change, so a scoped blob check
// on that single file counts it as reused (anti-gaming: only fires when the
// declaring file was genuinely modified).
function isInPlaceExtension(entry, changedSet, blobs) {
  return (
    declaringFileModified(entry, changedSet, blobs) &&
    symbolPresentInBlobsScoped(entry.symbol, blobs, normalizeRepoPath(entry.path))
  );
}

// GH-607 (R2/P0.2): config-file entry — non-JS/TS declared path matched per-file AND
// per-added-line: only the declared file's OWN `git diff -U0` added lines satisfy it
// (never the combined/all-blobs set — Greptile P1). Fallback (Greptile P1): when the
// diff is UNAVAILABLE (readAddedLines null) do NOT use full blob content — the symbol
// trivially pre-exists in its own config file, so fail toward not-reused (no stale pass).
function isConfigEntryReused(ctx, entry, changedSet) {
  if (!isConfigPath(entry.path)) return false;
  const norm = normalizeRepoPath(entry.path);
  const scoped = readAddedLines(ctx, [norm]);
  if (scoped === null) return false;
  return configEntryPresent(entry, scoped, changedSet);
}

// Returns true when `entry` counts as reused. Config-path entries are judged
// SOLELY by their declared file (above); the primary combined-diff / all-blobs
// symbol check must NOT run for them, or the config symbol text in an unrelated
// changed file would leak a false pass (Greptile P1). Importable-symbol entries
// use the added-line check (B3) + legacy full-content fallback + in-place relax.
function isReuseEntrySatisfied(ctx, entry, blobs, addedLines, changedSet) {
  if (isConfigPath(entry.path)) return isConfigEntryReused(ctx, entry, changedSet);
  const addedHit = symbolPresentInAdded(entry.symbol, addedLines);
  const present = addedHit === null ? symbolPresentInBlobs(entry.symbol, blobs) : addedHit;
  return present || isInPlaceExtension(entry, changedSet, blobs);
}

function checkMustReuseEntries(ctx, entries, blobs, joined, addedLines, failures, changedSet) {
  let mustChecked = 0;
  let mustMissing = 0;
  for (const entry of entries) {
    if (!entry || entry.mustReuse !== true) continue;
    mustChecked += 1;
    if (isReuseEntrySatisfied(ctx, entry, blobs, addedLines, changedSet)) continue;
    mustMissing += 1;
    failures.push(
      buildMissingFailure(entry, joined, declaredInUnmodifiedFile(ctx, entry, changedSet))
    );
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
    // GH-607: canonicalize the change-set keys so `entry.path` (spec-declared
    // spelling like `./hooks.json`) matches git's repo-relative output.
    const changedSet = new Set(changed.map(normalizeRepoPath));
    const blobs = loadChangedContents(ctx, changed);
    const joined = blobs.map((b) => b.content).join('\n');
    const addedLines = readAddedLines(ctx, changed);
    const { mustChecked, mustMissing } = checkMustReuseEntries(
      ctx,
      entries,
      blobs,
      joined,
      addedLines,
      failures,
      changedSet
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
module.exports.symbolPresentInBlobsScoped = symbolPresentInBlobsScoped;
module.exports.isConfigPath = isConfigPath;
module.exports.configEntryPresent = configEntryPresent;
module.exports.normalizeRepoPath = normalizeRepoPath;
