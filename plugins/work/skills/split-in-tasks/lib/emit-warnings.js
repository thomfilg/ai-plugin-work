'use strict';

/**
 * emit-warnings — pure formatter + dedupe helpers for SPLIT-WARNING records.
 *
 * Warning record shape: { kind: 'A'|'B'|'C'|'D', file: string, message: string, hint?: string }
 *
 * No I/O. No console.*. No process.exit at module scope. Suitable for use
 * under all four passes (chronological, contract, lint-blast-radius,
 * type-ac-consistency) and the operator integration entry.
 *
 * Also exposes a CLI entrypoint: `node emit-warnings.js <ticket-dir>` parses
 * the ticket's tasks.md, runs the kind-D Type/AC consistency lint via
 * `lint-type-ac-consistency.js`, prints any aggregated SPLIT-WARNING lines,
 * and exits non-zero when at least one kind-D warning is emitted.
 */

const fs = require('node:fs');
const path = require('node:path');
const { lintAllPassD, parseFilesInScope } = require('./lint-type-ac-consistency');

const WARNING_PREFIX = '> ⚠️ SPLIT-WARNING:';

/**
 * Replace any leading or embedded $HOME prefix with `~` so emitted text
 * is portable across operators and CI logs (R11).
 *
 * @param {string} text
 * @returns {string}
 */
function stripHome(text) {
  if (typeof text !== 'string') return text;
  const home = process.env.HOME;
  if (!home) return text;
  // Replace every occurrence of $HOME (longest-first via direct string replace).
  return text.split(home).join('~');
}

/**
 * Render a single warning record as a blockquote line.
 *
 * @param {{kind:string, file:string, message:string, hint?:string}} w
 * @returns {string}
 */
function renderLine(w) {
  const kind = w.kind != null ? String(w.kind) : '';
  const file = stripHome(w.file != null ? String(w.file) : '');
  const message = stripHome(w.message != null ? String(w.message) : '');
  const hint = w.hint != null ? stripHome(String(w.hint)) : '';
  const hintSuffix = hint ? ` — hint: ${hint}` : '';
  return `${WARNING_PREFIX} [Pass ${kind}] ${file}: ${message}${hintSuffix}`;
}

/**
 * Format an array of warning records as a newline-joined blockquote block.
 * Each record renders to one `> ⚠️ SPLIT-WARNING:` line.
 *
 * @param {Array<object>} warnings
 * @returns {string}
 */
function formatWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return '';
  return warnings.map(renderLine).join('\n');
}

/**
 * Split a `kind` field into its component pass identifiers.
 * Already-merged warnings carry compound kinds like `"A+C"`.
 *
 * @param {unknown} kind
 * @returns {string[]}
 */
function splitKinds(kind) {
  return String(kind || '')
    .split(/[+,\s]+/)
    .filter(Boolean);
}

/**
 * Merge two warnings that target the same file path.
 *
 * Contract:
 *  - `file` is preserved from the first warning (the dedupe key).
 *  - `kind` is the union of both warnings' kinds, sorted, joined with `+`.
 *  - `message` concatenates non-empty messages with ` | ` for traceability.
 *  - `hint` cites every contributing pass (R7/R8) — never silently drops info.
 *
 * @param {object} a — accumulator (already-merged or first warning for this file)
 * @param {object} b — incoming warning to fold in
 * @returns {object}
 */
/**
 * Strip a leading `cites Pass <kinds>: ` citation prefix from a hint, if present.
 * Iterative merges via `dedupe` re-prefix every step, so we must remove the
 * previous citation before re-applying the union citation — otherwise the inner
 * citation gets embedded inside the outer one.
 *
 * @param {string} hint
 * @returns {string}
 */
function stripCitationPrefix(hint) {
  return String(hint).replace(/^cites Pass [^:]+:\s*/, '');
}

function mergeWarnings(a, b) {
  const kinds = new Set([...splitKinds(a.kind), ...splitKinds(b.kind)]);
  const kind = Array.from(kinds).sort().join('+');
  const messages = [a.message, b.message].filter(Boolean);
  const hints = [a.hint, b.hint].filter(Boolean).map(stripCitationPrefix).filter(Boolean);
  const citation = `cites Pass ${kind}`;
  return {
    file: a.file,
    kind,
    message: messages.join(' | '),
    hint: hints.length > 0 ? `${citation}: ${hints.join(' | ')}` : citation,
  };
}

/**
 * Collapse warnings that share a `file` path into one merged record.
 * Preserves first-seen order. Distinct file paths remain separate.
 *
 * @param {Array<object>} warnings
 * @returns {Array<object>}
 */
function dedupe(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return [];
  const byFile = new Map();
  const order = [];
  for (const w of warnings) {
    if (!w || w.file == null) continue;
    const key = String(w.file);
    if (byFile.has(key)) {
      byFile.set(key, mergeWarnings(byFile.get(key), w));
    } else {
      byFile.set(key, { ...w });
      order.push(key);
    }
  }
  return order.map((k) => byFile.get(k));
}

/**
 * Parse a tasks.md string into the minimal task model the kind-D linter
 * expects: `{ file, tasks: [{ number, section, acceptanceCriteria }] }`.
 *
 * Splits on `^## Task N` headings. For each section, captures the literal
 * AC bullet lines under `### Acceptance Criteria` until the next `###`
 * or `## ` heading.
 *
 * @param {string} md
 * @param {string} file
 * @returns {{ file: string, tasks: Array<{ number: number, section: string, acceptanceCriteria: string[] }> }}
 */
function parseTasksMdForTypeAc(md, file) {
  const tasks = [];
  if (typeof md !== 'string' || md.length === 0) return { file, tasks };
  const parts = md.split(/^## Task /m).slice(1);
  for (const raw of parts) {
    const section = `## Task ${raw}`;
    const headerMatch = raw.match(/^(\d+)\b/);
    const number = headerMatch ? Number(headerMatch[1]) : null;
    const acceptanceCriteria = extractAcceptanceCriteria(raw);
    const filesInScope = parseFilesInScope(section);
    tasks.push({ number, section, acceptanceCriteria, filesInScope });
  }
  return { file, tasks };
}

function extractAcceptanceCriteria(section) {
  const lines = section.split(/\r?\n/);
  const out = [];
  let inAc = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^###\s+Acceptance Criteria\s*$/i.test(trimmed)) {
      inAc = true;
      continue;
    }
    if (!inAc) continue;
    if (/^###\s+/.test(trimmed) || /^##\s+/.test(trimmed)) break;
    const bullet = trimmed.match(/^[-*]\s+(.*)$/);
    if (bullet) out.push(bullet[1].trim());
  }
  return out;
}

/**
 * Aggregate kind-D warnings for a ticket directory by reading tasks.md
 * and invoking `lintTypeAcConsistency` once per parsed task. Reuses the
 * existing `dedupe` path so a future multi-pass run can fold these into
 * the broader SPLIT-WARNING aggregation.
 *
 * @param {string} ticketDir
 * @returns {Array<object>} merged warning records (may be empty)
 */
function aggregateTypeAcWarnings(ticketDir) {
  const tasksPath = path.join(ticketDir, 'tasks.md');
  if (!fs.existsSync(tasksPath)) return [];
  const md = fs.readFileSync(tasksPath, 'utf8');
  const model = parseTasksMdForTypeAc(md, 'tasks.md');
  // Pass D: collect EVERY kind-D warning (full Type/AC/scope consistency
  // sweep), not just the first docs-exemption mismatch. The legacy single-
  // warning helper `lintTypeAcConsistency` is preserved for callers that
  // only need the binary signal.
  const warnings = lintAllPassD(model);
  // Use a stable per-warning key so distinct violations on the same task
  // don't merge into one cryptic message. dedupe() folds by `file` alone,
  // which made multi-violation tasks collapse — we use {file, message} to
  // preserve them.
  return dedupeByMessage(warnings);
}

/**
 * Stable per-warning dedupe: two warnings dedupe only when both `file` AND
 * `message` match exactly. Used for Pass D where one task may emit several
 * distinct violations.
 */
function dedupeByMessage(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return [];
  const seen = new Set();
  const out = [];
  for (const w of warnings) {
    if (!w) continue;
    const key = `${w.file || ''}::${w.message || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

module.exports = {
  formatWarnings,
  dedupe,
  dedupeByMessage,
  parseTasksMdForTypeAc,
  aggregateTypeAcWarnings,
  WARNING_PREFIX,
};

// ─── CLI entrypoint ─────────────────────────────────────────────────────────
//
// Usage: `node emit-warnings.js <ticket-dir>` — parses ticket's tasks.md,
// runs all Pass D checks via aggregateTypeAcWarnings, prints aggregated
// SPLIT-WARNING lines, and exits non-zero when any are emitted. Matches the
// docstring contract.
//
// Designed to be invokable both directly and from SKILL.md Step 5 alongside
// Pass A/B/C. The CLI takes a single positional arg (ticket dir).
function runCli(argv) {
  const args = (argv || []).slice(2);
  const ticketDir = args.find((a) => a && !a.startsWith('-'));
  if (!ticketDir) {
    process.stderr.write('usage: emit-warnings.js <ticket-dir>\n');
    process.exit(2);
  }
  let warnings;
  try {
    warnings = aggregateTypeAcWarnings(ticketDir);
  } catch (err) {
    process.stderr.write(`emit-warnings: ${err && err.message ? err.message : String(err)}\n`);
    process.exit(2);
  }
  if (!warnings || warnings.length === 0) {
    process.exit(0);
  }
  process.stdout.write(formatWarnings(warnings) + '\n');
  process.exit(1);
}

// Only dispatch when invoked as a script. Using process.exit(0) instead of
// top-level `return` because the standalone biome parser used by pre-commit
// rejects top-level `return` (see commit 497c1d292).
if (require.main === module) {
  runCli(process.argv);
}
