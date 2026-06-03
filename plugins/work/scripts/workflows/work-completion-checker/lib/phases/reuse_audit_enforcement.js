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

const { COMPLETION_PHASES } = require('../../completion-phase-registry');
const { readReuseAudit, readChangedFiles } = require('../kind-checks/shared');
const { makeFailure } = require('../failure-record');
const { appendForCheckType } = require('../failure-store');
const { escapeRegex } = require('../../../lib/parse-completion-status');

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

// Proxy check: returns true when the symbol appears anywhere in the full
// content of a changed file — not strictly in the added hunks. A file that
// already contained the symbol in untouched code passes even if the change
// added an alternative implementation alongside it. The suffix-candidate
// hint in `buildMissingFailure` catches the most common drift case
// (e.g. `ContentPageToolbar` declared MUST-reuse, but the diff introduces
// `ExploreBulkToolbar` while the original is unreferenced).
function symbolPresentIn(symbol, fileBlobs) {
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

function checkMustReuseEntries(entries, blobs, joined, failures) {
  let mustChecked = 0;
  let mustMissing = 0;
  for (const entry of entries) {
    if (!entry || entry.mustReuse !== true) continue;
    mustChecked += 1;
    if (symbolPresentIn(entry.symbol, blobs)) continue;
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

async function validate(ctx) {
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
    const { mustChecked, mustMissing } = checkMustReuseEntries(entries, blobs, joined, failures);
    ctx.reuseAuditChecked = mustChecked;
    appendForCheckType(
      ctx.tasksDir,
      'reuse_audit',
      failures.slice(startLen),
      { reuseChecked: mustChecked },
    );

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
