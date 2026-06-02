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
  const re = new RegExp(`\\b\\w+${suffix}\\b`, 'g');
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

/**
 * Escape RegExp metacharacters so `symbol` is matched literally. Without
 * this, audit entries containing `.`, `[`, `(`, etc. would either match
 * wildcards (false positives, e.g. `Object.create` matching `ObjectXcreate`)
 * or throw `SyntaxError` mid-regex (e.g. `foo[bar]`), which the phase's
 * fail-closed `catch` would swallow and silently bypass enforcement.
 *
 * @param {string} str
 * @returns {string}
 */
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function symbolPresentIn(symbol, fileBlobs) {
  const re = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
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
    requirementId: entry.requirementId || 'R1',
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

async function validate(ctx) {
  const failures = ctx.failures || (ctx.failures = []);
  let entries;
  try {
    entries = readReuseAudit(ctx.tasksDir);
  } catch (err) {
    return {
      ok: false,
      errors: [`parser threw: ${errMessage(err)}`],
      summary: 'reuse audit parser error (fail-closed)',
    };
  }

  if (entries === null) {
    return { ok: true, summary: 'no Reuse Audit section — skipped' };
  }

  try {
    const changed = readChangedFiles(ctx) || [];
    const blobs = loadChangedContents(ctx, changed);
    const joined = blobs.map((b) => b.content).join('\n');
    const { mustChecked, mustMissing } = checkMustReuseEntries(entries, blobs, joined, failures);
    ctx.reuseAuditChecked = mustChecked;

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
module.exports.escapeRegExp = escapeRegExp;
