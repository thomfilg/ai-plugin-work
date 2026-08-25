/**
 * Pure text scanning for `surface_audit` — no filesystem, no phase wiring.
 *
 * Two questions live here:
 *   - Which backticked tokens in a brief/spec are CLAIMS about a sibling's
 *     surface, and what identifiers do they normalize to?
 *   - Does a line of prose actually reference a given sibling-owned file?
 *
 * Both were heuristics buried in the phase module; they carry most of the
 * audit's false-positive risk, so they are isolated here and unit-tested
 * directly.
 */

'use strict';

// Identifiers we never bother to check — common built-ins, primitives,
// and conventional null markers. Add sparingly.
const DENY = new Set([
  'string',
  'number',
  'boolean',
  'null',
  'undefined',
  'void',
  'any',
  'unknown',
  'true',
  'false',
  'Date',
  'Promise',
  'Array',
  'Record',
  'Partial',
  'Readonly',
  'Omit',
  'Pick',
  'object',
  'never',
  'this',
]);

/**
 * Pull every backticked token out of `text`. Returns an array of
 * { token, line } where line is the 1-based line number of the bullet
 * the token was found in (so the caller can correlate to nearby file
 * references).
 */
function isFilePathLike(token) {
  // Reject things that are clearly paths, not identifiers.
  if (token.includes('/')) return true;
  if (/\.(ts|tsx|js|jsx|json|md|yml|yaml|sql|sh|prisma|mjs|cjs)$/i.test(token)) return true;
  return false;
}

/**
 * Blank out the regions of a brief/spec that are evidence, not surface claims,
 * so their backticks are never read as "this identifier exists on a sibling".
 *
 *   - The whole `## Open Questions` section. Its bullets are, by construction,
 *     things the author could NOT resolve — the opposite of a claim.
 *   - Any `Searched:` annotation, wherever it appears. `brief-next.js` phase
 *     `draft` REQUIRES one on every open question ("Searched: `docker/Dockerfile`
 *     documents `SEED_DATABASE` as a build arg"), so auditing that text made the
 *     two phases contradict each other: the brief could not pass `draft` without
 *     the evidence line, then could not pass `surface_audit` because of it.
 *
 * Lines are blanked (not deleted) so reported line numbers stay accurate.
 */
function stripEvidenceProse(text) {
  if (!text) return text;
  const lines = text.split('\n');
  let inOpenQuestions = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      inOpenQuestions = /^##\s+Open Questions(?=\s|$)/i.test(line);
    }
    if (inOpenQuestions || /^\s*(?:[-*+]\s+)?\**Searched:/i.test(line)) lines[i] = '';
  }
  return lines.join('\n');
}

function extractBacktickIdentifiers(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Backtick spans — non-greedy, single-line.
    const re = /`([^`\n]+)`/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const token = m[1].trim();
      if (!token) continue;
      // File paths are not identifiers — surface_audit verifies the
      // identifiers AT those paths, not the paths themselves.
      if (isFilePathLike(token)) continue;
      out.push({ token, line: i + 1, lineText: line });
    }
  }
  return out;
}

/**
 * Try to extract a short identifier from a backtick token that may be a
 * dotted path, generic-indexed type, or plain name. Returns either:
 *   - a string (one identifier to check) for trivial cases, or
 *   - an array of strings if the token contains multiple identifier-like
 *     subparts the caller should check individually.
 *
 * Heuristics, not parsing — biased toward false negatives (skip), not
 * false positives (block).
 */
function normalizeIdentifier(token) {
  // Strip type-args / generics / index access.
  let t = token.trim();
  if (!t) return null;
  // Disallow tokens that include obvious code noise (parens, arrows, etc).
  if (/[()=>{}]/.test(t)) return null;
  // Generic-indexed: `RouterOutputs['explore']['list']['items'][number]`
  //   → keep the leading base identifier AND the bracketed string keys.
  if (/\[/.test(t)) {
    const base = t.split('[')[0].trim();
    const keys = [...t.matchAll(/\[\s*['"]([^'"]+)['"]\s*\]/g)].map((m) => m[1]);
    const out = [base, ...keys].filter(Boolean).filter((x) => !DENY.has(x));
    return out.length ? out : null;
  }
  // Dotted: `exploreItemSchema.workbookId` → check both.
  if (t.includes('.')) {
    const parts = t
      .split('.')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) return null;
    const out = parts.filter((p) => /^[A-Za-z_$][\w$]*$/.test(p) && !DENY.has(p));
    return out.length ? out : null;
  }
  // Plain identifier.
  if (!/^[A-Za-z_$][\w$]*$/.test(t)) return null;
  if (DENY.has(t)) return null;
  return t;
}

// Path-ish runs in a line of prose: either a token with a `/` in it, or a bare
// filename with a source-file extension. Backticks/quotes are outside the char
// class, so `` `lib/a.ts` `` yields `lib/a.ts`.
const PATH_TOKEN_RE =
  /[A-Za-z0-9_@.~-]+(?:\/[A-Za-z0-9_@.~*-]+)+|\b[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|sql|sh|prisma|mjs|cjs)\b/g;

/** Trailing glob segments (`components/pulse/**`) reduced to their directory. */
function globBase(file) {
  const base = file.replace(/\/+\*+$/, '').replace(/\/+$/, '');
  return base === file ? null : base;
}

const RE_META = /[.*+?^${}()|[\]\\]/g;

/**
 * Compile a surface glob to a regex. Interior wildcards matter: a surface is
 * commonly declared as `app/<double-star>/page.tsx`, and reducing only TRAILING
 * globs left such a surface matching nothing but its own literal spelling.
 *
 *   double-star + slash → any number of whole segments
 *   double-star          → anything, separators included
 *   `*` → anything within one segment; `?` → one char within one segment
 */
function globToRegExp(file) {
  if (!/[*?]/.test(file)) return null;
  let out = '';
  for (const part of file.split(/(\*\*\/|\*\*|\*|\?)/)) {
    if (part === '') continue;
    if (part === '**/') out += '(?:[^/]+/)*';
    else if (part === '**') out += '.*';
    else if (part === '*') out += '[^/]*';
    else if (part === '?') out += '[^/]';
    else out += part.replace(RE_META, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/**
 * Is the surface path written out verbatim in the line?
 *
 * Needed for surfaces `PATH_TOKEN_RE` cannot tokenize — a root-level
 * extensionless file like `Dockerfile` or `Makefile` has no `/` and no
 * extension, so token alignment alone never sees it and a real sibling
 * dependency silently degraded from error to warning. Boundary-anchored so
 * `Dockerfile` does not match inside `Dockerfile.web`.
 */
function lineMentionsLiteral(lineText, file) {
  const esc = file.replace(RE_META, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_@./~*-])${esc}(?![A-Za-z0-9_@.~-])`).test(lineText);
}

/**
 * Does `token` (a path written in the prose) refer to surface file `file`?
 *
 * Path-SUFFIX alignment, not bare-basename containment. `tasks/CHAR-8178/
 * ticket.json` and sibling surface `tasks/CHAR-8177/ticket.json` share the
 * basename `ticket.json` and nothing else; the old basename test tied every
 * identifier on that line to the sibling and hard-blocked the spec phase.
 * Generic filenames (`ticket.json`, `index.ts`, `page.tsx`, `route.ts`) made
 * that collision routine.
 */
function pathRefersTo(token, file) {
  const gb = globBase(file);
  if (gb && (token === gb || token.startsWith(`${gb}/`))) return true;
  const glob = globToRegExp(file);
  if (glob) return glob.test(token);
  return token === file || file.endsWith(`/${token}`) || token.endsWith(`/${file}`);
}

function lineRefersToFile(lineText, file) {
  if (lineMentionsLiteral(lineText, file)) return true;
  const tokens = lineText.match(PATH_TOKEN_RE) || [];
  return tokens.some((tok) => pathRefersTo(tok.replace(/\/+$/, ''), file));
}

module.exports = {
  DENY,
  isFilePathLike,
  stripEvidenceProse,
  extractBacktickIdentifiers,
  normalizeIdentifier,
  lineRefersToFile,
};
