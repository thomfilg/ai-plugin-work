'use strict';

/**
 * `cyclomatic` rule.
 *
 * Flags any function whose cyclomatic complexity exceeds the threshold
 * (default 10).
 *
 * Complexity = 1 (base) + count of decision points within the function body:
 *   - `if`, `else if` (each `if` keyword)
 *   - `for`, `while`, `do`
 *   - `case`
 *   - `catch`
 *   - `&&`, `||`
 *   - `?` (ternary)
 *
 * String and comment occurrences of the above tokens are ignored via a
 * dedicated token-stripping pass.
 *
 * Pure function: no filesystem I/O; depends only on `filePath` and `source`.
 */

const DEFAULT_THRESHOLD = 10;
const RULE_ID = 'cyclomatic';

const FN_PATTERNS = [
  { re: /\b(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g, kind: 'decl' },
  {
    re: /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b[^(]*\(|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
    kind: 'assigned',
  },
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

function findOpenBrace(source, fromIndex) {
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
    if (ch === ';') return -1;
    i++;
  }
  return -1;
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

/**
 * Strip string literals and comments from `source`, replacing them with
 * spaces of the same length so that indices in the returned string still
 * align with the original. This lets us run cheap regex counts without
 * false positives inside strings/comments.
 */
function stripStringsAndComments(source) {
  const out = source.split('');
  let i = 0;
  while (i < out.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
      const end = Math.min(source.length, i + 2);
      for (let k = start; k < end; k++) {
        if (out[k] !== '\n') out[k] = ' ';
      }
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const start = i;
      const end = skipString(source, i);
      for (let k = start; k < end && k < source.length; k++) {
        if (out[k] !== '\n') out[k] = ' ';
      }
      i = end;
      continue;
    }
    i++;
  }
  return out.join('');
}

function countComplexity(stripped) {
  // 1 base + decision points
  let complexity = 1;
  const patterns = [
    /\bif\b/g,
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bcase\b/g,
    /\bcatch\b/g,
    /&&/g,
    /\|\|/g,
    /(?<!\?)\?(?![.?])/g, // ternary; exclude optional-chaining `?.` and nullish-coalescing `??`
  ];
  for (const re of patterns) {
    const matches = stripped.match(re);
    if (matches) complexity += matches.length;
  }
  return complexity;
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
        name = m[2];
        nameIdx = m.index + m[0].indexOf(name);
      } else {
        name = m[1];
        nameIdx = m.index + m[0].indexOf(name);
      }
      if (!name || KEYWORDS.has(name)) continue;
      const afterMatch = m.index + m[0].length;
      const openIdx = findOpenBrace(source, afterMatch - 1);
      if (openIdx < 0) continue;
      const closeIdx = findMatchingClose(source, openIdx);
      if (closeIdx < 0) continue;
      const startLine = lineOfIndex(source, nameIdx);
      found.push({ name, startLine, openIdx, closeIdx });
    }
  }
  return dedupeByBody(found);
}

function dedupeByBody(fns) {
  const byOpen = new Map();
  for (const fn of fns) {
    if (!byOpen.has(fn.openIdx)) byOpen.set(fn.openIdx, fn);
  }
  return Array.from(byOpen.values());
}

/**
 * Compute the body slice of a function with nested-function bodies blanked
 * out, so that decisions inside nested functions are not attributed to the
 * outer function.
 */
function bodyExcludingNested(stripped, fn, allFns) {
  const chars = stripped.slice(fn.openIdx + 1, fn.closeIdx).split('');
  for (const other of allFns) {
    if (other === fn) continue;
    if (other.openIdx > fn.openIdx && other.closeIdx < fn.closeIdx) {
      const start = other.openIdx + 1 - (fn.openIdx + 1);
      const end = other.closeIdx - (fn.openIdx + 1);
      for (let k = start; k < end && k < chars.length; k++) {
        if (chars[k] !== '\n') chars[k] = ' ';
      }
    }
  }
  return chars.join('');
}

function check(filePath, source) {
  if (!source) return [];
  const stripped = stripStringsAndComments(source);
  const fns = collectFunctions(source);
  const violations = [];
  for (const fn of fns) {
    const body = bodyExcludingNested(stripped, fn, fns);
    const complexity = countComplexity(body);
    if (complexity > DEFAULT_THRESHOLD) {
      violations.push({
        rule: RULE_ID,
        line: fn.startLine,
        severity: 'error',
        message: `cyclomatic-complexity > ${DEFAULT_THRESHOLD} (${complexity}) in ${fn.name}`,
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
