/**
 * Phase: diff_scope — Gate E (scope-diff verification).
 *
 * Classifies every changed file as in-scope / out-of-scope (sibling-owned) /
 * unaccounted (not in any task's `### Files in scope`). out-of-scope > 0
 * BLOCKS completion (the ECHO-4579 lesson). unaccounted > 0 surfaces as a
 * warning the agent must justify.
 *
 * GH-408 false-positive family (ECHO-5150/5352/5357/5358/5360/5538/5813/5815):
 * - Both scope parsers walk EVERY task's `###`-bounded subsection; sibling
 *   h3 sections (`### Deliverables`, `### Test Command`, `### Suggested
 *   Scope`, …) never bleed into the out-of-scope set.
 * - Out-of-scope tokens that are obviously not file paths (code identifiers
 *   like `refreshExtractsMany` — no slash, no dot-extension) are ignored.
 * - In-scope wins: a file declared under ANY task's `### Files in scope` in
 *   the same tasks.md is intra-ticket task bookkeeping, not cross-ticket
 *   ownership — sibling-owned = outOfScope − unionInScope.
 * - `scope-accepted.json` provides a documented, file-exact unblock path for
 *   residual false positives (no blanket bypass).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { COMPLETION_PHASES } = require('../../completion-phase-registry');
const { readChangedFiles, readTasks, sliceSubsections } = require('../kind-checks/shared');

/** Collect every backticked token inside each matching `###` subsection. */
function collectBacktickedTokens(tasksText, headingRe) {
  const out = new Set();
  for (const block of sliceSubsections(tasksText, headingRe)) {
    for (const line of block.split('\n')) {
      const b = line.match(/`([^`\n]+)`/g);
      if (!b) continue;
      for (const tok of b) out.add(tok.replace(/`/g, '').trim());
    }
  }
  return out;
}

/**
 * Heuristic: does a backticked token plausibly name a file/glob rather than
 * a code identifier? Paths carry a slash (incl. globs like `components/**`)
 * or a dot-extension (`schema.prisma`). Bare identifiers (`useFoo`,
 * `refreshExtractsMany`) and prose fragments (contain whitespace) do not.
 */
function looksLikeFilePath(tok) {
  if (!tok || /\s/.test(tok)) return false;
  if (tok.includes('/')) return true;
  return /\.[A-Za-z0-9_-]+$/.test(tok);
}

function parseFilesInScope(tasksText) {
  if (!tasksText) return new Set();
  return collectBacktickedTokens(tasksText, /^###\s+Files in scope\b/im);
}

function parseFilesOutOfScope(tasksText) {
  if (!tasksText) return new Set();
  const tokens = collectBacktickedTokens(tasksText, /^###\s+Files explicitly out of scope\b/im);
  const out = new Set();
  for (const tok of tokens) if (looksLikeFilePath(tok)) out.add(tok);
  return out;
}

function classify(ctx) {
  const tasksText = readTasks(ctx.tasksDir);
  const inScope = parseFilesInScope(tasksText);
  const outOfScope = parseFilesOutOfScope(tasksText);
  const changed = readChangedFiles(ctx);
  const inList = [];
  const outList = [];
  const unaccounted = [];
  for (const f of changed) {
    // In-scope wins (GH-408): tasks in the SAME tasks.md routinely list each
    // other's files under `### Files explicitly out of scope` as per-task
    // bookkeeping. Only files claimed by NO task here are sibling-owned.
    if (inScope.has(f)) inList.push(f);
    else if (outOfScope.has(f)) outList.push(f);
    else unaccounted.push(f);
  }
  return { inScope: inList, outOfScope: outList, unaccounted, total: changed.length };
}

const CTX_FILE = 'completion-scope.json';
const OVERRIDE_FILE = 'scope-accepted.json';

/**
 * Read the optional `scope-accepted.json` override (ECHO-5150/5813 unblock
 * path). Shape: `{ "reason": "<non-empty justification>", "files": ["exact/
 * path.ts", …] }`. Only exact path matches are honored — no globs, no
 * blanket bypass — and both fields are mandatory. Returns null when absent
 * or malformed.
 */
function readScopeOverride(tasksDir) {
  const p = path.join(tasksDir, OVERRIDE_FILE);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.reason !== 'string' || !raw.reason.trim()) return null;
  if (!Array.isArray(raw.files)) return null;
  const files = raw.files.filter((f) => typeof f === 'string' && f.trim()).map((f) => f.trim());
  if (files.length === 0) return null;
  return { reason: raw.reason.trim(), files: new Set(files) };
}

/** Partition out-of-scope files into override-accepted vs still blocked. */
function splitByOverride(outOfScope, override) {
  const accepted = [];
  const blocked = [];
  for (const f of outOfScope) {
    if (override && override.files.has(f)) accepted.push(f);
    else blocked.push(f);
  }
  return { accepted, blocked };
}

/** Persist the classification snapshot (hook-gated; non-fatal on failure). */
function writeScopeSnapshot(ctx, r, blocked, accepted, override) {
  try {
    fs.writeFileSync(
      path.join(ctx.tasksDir, CTX_FILE),
      JSON.stringify(
        {
          ...r,
          outOfScope: blocked,
          accepted,
          acceptedReason: accepted.length ? override.reason : undefined,
          snapshotAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  } catch {
    /* hook-gated; non-fatal */
  }
}

function validate(ctx) {
  const r = classify(ctx);
  const errors = [];
  const warnings = [];
  const override = readScopeOverride(ctx.tasksDir);
  const { accepted, blocked } = splitByOverride(r.outOfScope, override);
  if (blocked.length) {
    errors.push(
      `Gate E: ${blocked.length} sibling-owned (out of scope) file(s) modified: ${blocked
        .map((f) => `\`${f}\``)
        .join(', ')}. BLOCK completion — revert these edits or file a sibling-gap question.`
    );
  }
  if (accepted.length) {
    warnings.push(
      `Gate E: ${accepted.length} out-of-scope file(s) accepted via ${OVERRIDE_FILE} — ${accepted
        .map((f) => `\`${f}\``)
        .join(', ')}. Reason: ${override.reason}`
    );
  }
  if (r.unaccounted.length) {
    warnings.push(
      `Gate E: ${r.unaccounted.length} unaccounted file(s) (not declared in any task's \`### Files in scope\`): ${r.unaccounted
        .slice(0, 5)
        .map((f) => `\`${f}\``)
        .join(
          ', '
        )}${r.unaccounted.length > 5 ? ', …' : ''}. Justify each in the PR description under \`## Out-of-scope changes\` or revert.`
    );
  }
  writeScopeSnapshot(ctx, r, blocked, accepted, override);
  return {
    ok: errors.length === 0,
    errors,
    warnings,
    summary: `in:${r.inScope.length} out:${blocked.length}${accepted.length ? ` accepted:${accepted.length}` : ''} unaccounted:${r.unaccounted.length} (of ${r.total})`,
  };
}

function instructions(ctx) {
  return [
    '# completion-next — Phase 3 of 11: DIFF SCOPE (Gate E)',
    `Ticket: ${ctx.ticket}`,
    '',
    'I classify every changed file against:',
    '- `### Files in scope` blocks across all tasks in tasks.md',
    '- `### Files explicitly out of scope` blocks across all tasks (sibling-owned)',
    '',
    "A file declared in-scope by ANY task wins over another task's out-of-scope",
    'listing (intra-ticket bookkeeping, not cross-ticket ownership).',
    '',
    'Out-of-scope > 0 → BLOCK. Unaccounted > 0 → must justify or revert.',
    '',
    'False-positive unblock: write `scope-accepted.json` next to tasks.md with',
    '`{ "reason": "<justification>", "files": ["exact/path.ts"] }`. Only the',
    'exact listed paths are excused (no globs); the acceptance is recorded as',
    'a warning and in completion-scope.json. Do NOT use it to smuggle real',
    'sibling-owned edits through.',
    '',
    'Re-invoke me after addressing the gate.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(COMPLETION_PHASES.diff_scope, {
    next: COMPLETION_PHASES.coverage_check,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.classify = classify;
module.exports.parseFilesInScope = parseFilesInScope;
module.exports.parseFilesOutOfScope = parseFilesOutOfScope;
module.exports.looksLikeFilePath = looksLikeFilePath;
module.exports.CTX_FILE = CTX_FILE;
module.exports.OVERRIDE_FILE = OVERRIDE_FILE;
