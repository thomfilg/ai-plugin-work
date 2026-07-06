'use strict';

/**
 * scan.js — propose values for scannable vars from files in the repo.
 *
 * A schema var may declare a `scan` block:
 *
 *   "scan": {
 *     "globs": [".rulesync/rules/*.md", "docs/ARCH.md"],
 *     "names": ["code-quality", "types"]        // optional basename filter
 *   }
 *
 * When such a var is unset (and not explicitly acknowledged as keep-unset),
 * scanFulfillable() expands the globs against the project root and proposes
 * a comma-separated value from the matches. The SessionStart hook uses this
 * to tell the user the var can be auto-filled; the configure skill uses it
 * to let the assistant scan the docs and propose the mapping.
 *
 * Globbing is intentionally minimal (no deps): `*` is supported in the
 * basename segment only — exactly what doc-folder patterns need.
 */

const fs = require('node:fs');
const path = require('node:path');

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Expand one pattern relative to projectRoot; returns relative paths. */
function expandGlob(projectRoot, pattern) {
  if (!pattern.includes('*')) {
    return fs.existsSync(path.join(projectRoot, pattern)) ? [pattern] : [];
  }
  const dir = path.dirname(pattern);
  const baseRe = new RegExp(`^${path.basename(pattern).split('*').map(escapeRegExp).join('.*')}$`);
  let entries;
  try {
    entries = fs.readdirSync(path.join(projectRoot, dir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && baseRe.test(entry.name))
    .map((entry) => path.posix.join(dir, entry.name))
    .sort();
}

function baseName(relPath) {
  return path.basename(relPath).replace(/\.[^.]+$/, '');
}

/** Resolve one var's scan block. Returns null when nothing matches. */
function scanVar(projectRoot, def) {
  const scan = def.scan;
  if (!scan || !Array.isArray(scan.globs)) return null;
  const candidates = [...new Set(scan.globs.flatMap((g) => expandGlob(projectRoot, g)))];
  if (candidates.length === 0) return null;
  const names = Array.isArray(scan.names) && scan.names.length > 0 ? new Set(scan.names) : null;
  const suggested = names ? candidates.filter((c) => names.has(baseName(c))) : candidates;
  return { candidates, suggested };
}

function isUnset(values, name) {
  const current = values[name];
  return !current || current.value === '';
}

/**
 * All scannable vars of a schema that are unset, unacknowledged, and have
 * at least one suggestion in this repo.
 * Returns [{ name, candidates, suggested, value }].
 */
function scanFulfillable({ schema, projectRoot, values = {}, acknowledged = new Set() }) {
  const out = [];
  for (const [name, def] of Object.entries(schema.vars)) {
    if (!def.scan) continue;
    if (!isUnset(values, name) || acknowledged.has(name)) continue;
    const result = scanVar(projectRoot, def);
    if (result && result.suggested.length > 0) {
      out.push({ name, ...result, value: result.suggested.join(',') });
    }
  }
  return out;
}

/**
 * Vars whose value needs repo-specific INTERPRETATION (custom commands,
 * app JSON, bootstrap scripts): schema marks them with an `agentFill`
 * block — `{ "hint": "how to derive it", "signals": ["package.json"] }` —
 * and the configure assistant derives a proposal from the repo instead of
 * asking blind. Included when unset, unacknowledged, and at least one
 * signal path exists (no signals declared → always eligible).
 * Returns [{ name, hint }].
 */
function signalsPresent(projectRoot, fill) {
  const signals = Array.isArray(fill.signals) ? fill.signals : [];
  if (signals.length === 0) return true;
  return signals.some((signal) => expandGlob(projectRoot, signal).length > 0);
}

function agentFillable({ schema, projectRoot, values = {}, acknowledged = new Set() }) {
  const out = [];
  for (const [name, def] of Object.entries(schema.vars)) {
    const fill = def.agentFill;
    if (!fill) continue;
    if (!isUnset(values, name) || acknowledged.has(name)) continue;
    if (!signalsPresent(projectRoot, fill)) continue;
    out.push({ name, hint: fill.hint || '' });
  }
  return out;
}

module.exports = { expandGlob, scanVar, scanFulfillable, agentFillable };
