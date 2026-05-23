'use strict';

/**
 * `max-lines-per-function` rule.
 *
 * Flags any function whose body exceeds the threshold (default 80 lines).
 *
 * Detects:
 *   - `function name(...) { ... }` (including `async function`)
 *   - `const name = (...) => { ... }` / `let` / `var`
 *   - method shorthand and class methods: `name(...) { ... }`
 *
 * Uses regex-based scanning + brace-balance walking. CommonJS-only repo,
 * so no parser is required. Pure function: depends only on `filePath` and
 * `source` arguments; performs no filesystem I/O.
 */

const DEFAULT_THRESHOLD = 80;
const RULE_ID = 'max-lines-per-function';

// Matches function declarations / expressions with a capture for the name.
// Patterns covered (one capture group named):
//   1) function NAME(...)            — incl. `async function`
//   2) const|let|var NAME = (args) => ... { OR `... => expression`
//   3) const|let|var NAME = function ...
//   4) class method shorthand: `NAME(...) {` (also covers method shorthand
//      in object literals; we filter by surrounding context heuristically)
//
// We scan the file once and for each match try to locate the opening `{`
// of the function body, then walk braces to find the matching `}`.

const FN_PATTERNS = [
  // async? function NAME(
  { re: /\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g, kind: 'decl' },
  // const|let|var NAME = async? (args) =>   OR  = async? function ...
  {
    re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b[^(]*\(|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
    kind: 'assigned',
  },
  // method shorthand / class methods: NAME(args) {
  // We use a conservative pattern requiring `(` then `)` then `{` on the
  // same logical span; we filter out obvious non-functions (keywords).
  {
    re: /(?:^|[\s;{}])((?:async\s+)?(?:static\s+)?(?:get\s+|set\s+)?\*?\s*([A-Za-z_$][\w$]*))\s*\([^()]*\)\s*\{/g,
    kind: 'method',
  },
];

const KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'do',
  'else',
  'function',
  'class',
  'new',
  'typeof',
  'in',
  'of',
  'await',
  'yield',
  'throw',
  'case',
  'with',
  'void',
  'delete',
  'instanceof',
]);

function lineOfIndex(source, index) {
  let line = 1;
  for (let i = 0; i < index && i < source.length; i++) {
    if (source.charCodeAt(i) === 10) line++;
  }
  return line;
}

function findOpenBrace(source, fromIndex) {
  // Walk forward, skipping strings/comments, looking for first `{`.
  let i = fromIndex;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '{') return i;
    // Stop early if we hit a statement terminator before any `{` — likely
    // an arrow with expression body, e.g. `const f = () => 1;`.
    if (ch === ';' || ch === '\n') {
      // Newlines are OK inside multi-line arrow signatures, only stop on `;`.
      if (ch === ';') return -1;
    }
    i++;
  }
  return -1;
}

function skipString(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    // Template literal `${...}` — skip nested braces.
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      i += 2;
      let depth = 1;
      while (i < source.length && depth > 0) {
        const c = source[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        else if (c === '"' || c === "'" || c === '`') {
          i = skipString(source, i);
          continue;
        }
        i++;
      }
      continue;
    }
    i++;
  }
  return i;
}

function findMatchingClose(source, openIndex) {
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(source, i);
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

function collectFunctions(source) {
  const found = [];
  for (const { re, kind } of FN_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(source)) !== null) {
      let name;
      let nameIdx;
      if (kind === 'method') {
        // pattern has 2 capture groups; group 2 is the bare name
        name = m[2];
        nameIdx = m.index + m[0].indexOf(name);
      } else {
        name = m[1];
        nameIdx = m.index + m[0].indexOf(name);
      }
      if (!name || KEYWORDS.has(name)) continue;
      // Find the function body brace.
      const afterMatch = m.index + m[0].length;
      const openIdx = findOpenBrace(source, afterMatch - 1);
      if (openIdx < 0) continue;
      const closeIdx = findMatchingClose(source, openIdx);
      if (closeIdx < 0) continue;
      const startLine = lineOfIndex(source, nameIdx);
      const openLine = lineOfIndex(source, openIdx);
      const closeLine = lineOfIndex(source, closeIdx);
      found.push({
        name,
        startLine,
        openLine,
        closeLine,
        openIdx,
        closeIdx,
      });
    }
  }
  return dedupeByBody(found);
}

function dedupeByBody(fns) {
  // The "method" pattern can overlap with the "decl" pattern for plain
  // `function NAME(` declarations. Deduplicate by body open index, keeping
  // the first occurrence (which carries the more precise start line).
  const byOpen = new Map();
  for (const fn of fns) {
    if (!byOpen.has(fn.openIdx)) byOpen.set(fn.openIdx, fn);
  }
  return Array.from(byOpen.values());
}

function check(filePath, source) {
  if (!source) return [];
  const fns = collectFunctions(source);
  const violations = [];
  for (const fn of fns) {
    const lines = fn.closeLine - fn.openLine + 1;
    if (lines > DEFAULT_THRESHOLD) {
      violations.push({
        rule: RULE_ID,
        line: fn.startLine,
        severity: 'error',
        message: `max-lines-per-function > ${DEFAULT_THRESHOLD} (${lines} lines) in ${fn.name}`,
      });
    }
  }
  return violations;
}

module.exports = {
  id: RULE_ID,
  defaultThreshold: DEFAULT_THRESHOLD,
  check,
};
