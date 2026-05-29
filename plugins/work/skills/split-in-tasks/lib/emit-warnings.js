'use strict';

/**
 * emit-warnings — pure formatter + dedupe helpers for SPLIT-WARNING records.
 *
 * Warning record shape: { kind: 'A'|'B'|'C', file: string, message: string, hint?: string }
 *
 * No I/O. No console.*. No process.exit. Suitable for use under all three passes
 * (chronological, contract, lint-blast-radius) and the operator integration entry.
 */

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

module.exports = {
  formatWarnings,
  dedupe,
  WARNING_PREFIX,
};
