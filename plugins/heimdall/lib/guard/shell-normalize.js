'use strict';

/**
 * Shell-obfuscation normalization, shared by the lock guard (bash.js) and the
 * conceal hook (hooks/heimdall-conceal.js).
 *
 * Both guards match protected paths against the LITERAL command text (after
 * `~`/`$HOME` expansion). But the shell expands quotes, backslashes, brace
 * lists and globs BEFORE running the command, so a protected path can be named
 * in a form the literal matcher never sees:
 *
 *   cat ~/.c[l]aude/x   (single-char class)   cat ~/.cl*ude/x   (wildcard)
 *   cat ~/.cl""aude/x   (quote split)          cat ~/.cla\ude/x  (backslash)
 *   cat ~/.{cl,x}aude/x (brace list)
 *
 * Strategy (fail-closed): recover the literal(s) each token can denote.
 *   1. `dequote` removes quoting/backslash escapes (reveals `.cl""aude`→`.claude`).
 *   2. `reduceSingleCharClasses` turns `[l]`→`l` (a single-char class is lossless).
 *   3. `expandBraces` enumerates `{a,b}` alternatives.
 * These feed `normalizedVariants`, which the existing literal patterns run over.
 *
 * True wildcards (`*`, `?`, multi-char classes) cannot be collapsed to a
 * literal, so `commandGlobReferencesMarker` / `commandGlobReferencesPath`
 * glob-match command tokens against the KNOWN protected marker/dir — precise
 * (an unrelated glob like `rm *.log` cannot match `.claude`) yet fail-closed
 * (any token that COULD expand onto the protected path counts as a reference).
 */

const MAX_BRACE_VARIANTS = 64;

/**
 * Strip shell quoting that splits or hides a literal. Quote CONTENT is kept and
 * concatenated with its neighbours, exactly as the shell would: `.cl""aude` and
 * `'.claude'` and `.cla\ude` all collapse to `.claude`.
 */
// Scan a quoted run starting just after the opening quote `q`; returns the
// unquoted content and the index just past the closing quote (or end-of-string
// for an unbalanced quote). Inside double quotes a backslash still escapes;
// inside single quotes it is literal (bash semantics).
function scanQuote(s, start, q) {
  let out = '';
  let i = start;
  while (i < s.length && s[i] !== q) {
    if (q === '"' && s[i] === '\\' && i + 1 < s.length) {
      out += s[i + 1];
      i += 2;
    } else {
      out += s[i];
      i += 1;
    }
  }
  return { out, next: i + 1 };
}

function dequote(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      i += 1;
      if (i < s.length) out += s[i];
    } else if (c === '"' || c === "'") {
      const r = scanQuote(s, i + 1, c);
      out += r.out;
      i = r.next - 1;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Reduce single-character bracket globs to the character they denote:
 * `[l]`→`l`, `[.]`→`.`, `[\.]`→`.`. A one-char class is exactly one literal, so
 * this is lossless and precise — it covers the `.c[l]aude` bypass. Negated
 * (`[!x]`/`[^x]`) and multi-char classes are left for glob-matching.
 */
function reduceSingleCharClasses(s) {
  return s.replace(/\[(\\?.)\]/g, (m, ch) => {
    if (ch === '!' || ch === '^') return m; // not a single literal
    return ch.length === 2 && ch[0] === '\\' ? ch[1] : ch;
  });
}

/** Expand `{a,b,c}` brace lists combinatorially, bounded. Ranges are ignored. */
function expandBraces(s, cap = MAX_BRACE_VARIANTS) {
  const m = s.match(/\{([^{}]*,[^{}]*)\}/);
  if (!m) return [s];
  const pre = s.slice(0, m.index);
  const post = s.slice(m.index + m[0].length);
  const out = [];
  for (const opt of m[1].split(',')) {
    for (const rest of expandBraces(pre + opt + post, cap)) {
      out.push(rest);
      if (out.length >= cap) return out;
    }
  }
  return out;
}

/** All normalized variants of a command to test literal patterns against. */
function normalizedVariants(command) {
  const seen = new Set();
  const add = (x) => {
    if (x && !seen.has(x)) seen.add(x);
  };
  const dq = dequote(command);
  for (const base of [command, dq]) {
    add(base);
    const reduced = reduceSingleCharClasses(base);
    add(reduced);
    for (const b of expandBraces(reduced)) add(b);
  }
  return [...seen];
}

const GLOB_META = /[*?[]/;
function hasGlobMeta(tok) {
  return GLOB_META.test(tok);
}

/** Split a command into path-like tokens on shell boundaries. */
function tokenize(s) {
  return s.split(/[\s"'`,;()|<>&=]+/).filter(Boolean);
}

// Copy a bracket char-class verbatim from index `i` (which points at `[`).
// Returns the compiled class and the index of its closing `]`.
function readCharClass(seg, i) {
  let j = i + 1;
  let cls = '[';
  if (seg[j] === '!' || seg[j] === '^') {
    cls += '^';
    j += 1;
  }
  if (seg[j] === ']') {
    cls += '\\]';
    j += 1;
  }
  while (j < seg.length && seg[j] !== ']') {
    cls += seg[j] === '\\' ? '\\\\' : seg[j];
    j += 1;
  }
  return { cls: `${cls}]`, next: j };
}

/** Compile one path SEGMENT glob to an anchored regex with `[^/]` semantics. */
function segGlobToRegExp(seg) {
  let re = '^';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const r = readCharClass(seg, i);
      re += r.cls;
      i = r.next;
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`${re}$`);
}

/**
 * A wildcard-bearing segment plausibly denotes `marker` only when it is ANCHORED
 * by a substantial literal run — a leading literal that is a prefix of the
 * marker, or a trailing literal that is its suffix (each ≥2 chars). This keeps
 * `*`/`*.log`/`src/*` from matching short markers (`ui`, `db`) — the #642
 * false-positive class — while still catching `.cl*ude` (lead `.cl`) and
 * `secretd*` (lead `secretd`).
 */
function globSegmentPlausiblyMarker(seg, marker) {
  const lead = (seg.match(/^[^*?[]+/) || [''])[0];
  const trail = (seg.match(/[^*?[\]]+$/) || [''])[0];
  const anchored =
    (lead.length >= 2 && marker.startsWith(lead)) ||
    (trail.length >= 2 && marker.endsWith(trail));
  return anchored && segGlobToRegExp(seg).test(marker);
}

/** True when any glob token has a segment that glob-matches the bare `marker`. */
function commandGlobReferencesMarker(command, marker) {
  if (!marker || marker.includes('/')) return false;
  for (const tok of tokenize(command)) {
    if (!hasGlobMeta(tok)) continue;
    for (const seg of tok.split('/')) {
      if (hasGlobMeta(seg) && globSegmentPlausiblyMarker(seg, marker)) return true;
    }
  }
  return false;
}

/**
 * True when a glob token denotes `litPath` (a multi-segment/absolute path) or a
 * child of it. At least one aligned segment must carry a glob metachar, so pure
 * literals (already handled by substring checks) don't double-count here.
 */
// Do `litPath`'s segments align onto `tSegs` starting at `start`, using at least
// one glob metachar (so a pure literal — already handled by substring checks —
// doesn't double-count here)?
function segmentsAlignAt(tSegs, lSegs, start) {
  let usedGlob = false;
  for (let i = 0; i < lSegs.length; i += 1) {
    const t = tSegs[start + i];
    const l = lSegs[i];
    if (hasGlobMeta(t)) {
      usedGlob = true;
      if (!segGlobToRegExp(t).test(l)) return false;
    } else if (t !== l) {
      return false;
    }
  }
  return usedGlob;
}

function commandGlobReferencesPath(command, litPath) {
  if (!litPath) return false;
  const lSegs = litPath.split('/');
  for (const tok of tokenize(command)) {
    if (!hasGlobMeta(tok)) continue;
    const tSegs = tok.split('/');
    for (let start = 0; start + lSegs.length <= tSegs.length; start += 1) {
      if (segmentsAlignAt(tSegs, lSegs, start)) return true;
    }
  }
  return false;
}

module.exports = {
  dequote,
  reduceSingleCharClasses,
  expandBraces,
  normalizedVariants,
  hasGlobMeta,
  tokenize,
  segGlobToRegExp,
  commandGlobReferencesMarker,
  commandGlobReferencesPath,
};
