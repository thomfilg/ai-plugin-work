'use strict';

/**
 * `max-depth` rule.
 *
 * Flags any control-flow nesting depth that exceeds the threshold (default 4).
 *
 * Counts toward depth only "control-flow blocks" — curly braces opened by:
 *   - function bodies (including arrow `=> {`, method shorthand)
 *   - `if`, `else`
 *   - `for`, `while`, `do`
 *   - `try`, `catch`, `finally`
 *   - `switch`
 *
 * Object literals, array literals, and template-literal `${...}` interpolations
 * are explicitly ignored.
 *
 * Pure function: depends only on `filePath` and `source`; no I/O.
 */

const DEFAULT_THRESHOLD = 4;
const RULE_ID = 'max-depth';

const CONTROL_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'while',
  'do',
  'try',
  'catch',
  'finally',
  'switch',
]);

function isIdentChar(ch) {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    (ch >= '0' && ch <= '9') ||
    ch === '_' ||
    ch === '$'
  );
}

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

/**
 * Decide whether the `{` at `openIdx` opens a control-flow block.
 *
 * Strategy: walk backwards from `openIdx` skipping whitespace and any
 * matched parenthesized expression (`(...)`), then read the preceding
 * identifier. If it's a control keyword, or if the preceding non-ident
 * context is an arrow `=>` or `else`/`do`/`try`/`finally` keyword, this
 * brace opens a control-flow block. Otherwise (assignment `=`, `(`, `,`,
 * `:`, `[`, `return`, ...), it's an object/expression brace.
 */
function isControlBrace(source, openIdx) {
  let i = openIdx - 1;
  // Skip whitespace.
  while (i >= 0 && /\s/.test(source[i])) i--;
  if (i < 0) return false;

  // `=> {` — arrow function body.
  if (source[i] === '>' && source[i - 1] === '=') return true;

  // `) {` — could be `if (...) {`, `for (...) {`, `function f() {`, etc.
  if (source[i] === ')') {
    // Walk back to matching `(`.
    let depth = 1;
    let j = i - 1;
    while (j >= 0 && depth > 0) {
      const ch = source[j];
      if (ch === '"' || ch === "'" || ch === '`') {
        // Walk back over a string literal — simple form, not bulletproof
        // but adequate for control headers which rarely contain strings.
        j--;
        while (j >= 0 && source[j] !== ch) j--;
        j--;
        continue;
      }
      if (ch === ')') depth++;
      else if (ch === '(') depth--;
      if (depth === 0) break;
      j--;
    }
    if (j < 0) return false;
    // j is at the matching `(`. Any `(...) {` shape opens a control-flow
    // block — either a control keyword header (`if (...) {`), a function
    // /method body (`name(...) {`), or an arrow/anonymous function body
    // (`(args) {` inside a `function (...) {` expression). Per spec,
    // function bodies count toward depth.
    return true;
  }

  // Bare keyword before `{` — `else {`, `do {`, `try {`, `finally {`.
  if (isIdentChar(source[i])) {
    const end = i + 1;
    let j = i;
    while (j >= 0 && isIdentChar(source[j])) j--;
    const ident = source.slice(j + 1, end);
    if (CONTROL_KEYWORDS.has(ident)) return true;
    return false;
  }

  // Otherwise (after `=`, `(`, `,`, `:`, `[`, `return`, ...): object/expr.
  return false;
}

function check(_filePath, source) {
  if (!source) return [];
  const violations = [];
  // Stack of booleans: true if the brace at this depth is a control-flow
  // brace and therefore counts toward the depth tally.
  const stack = [];
  let depth = 0;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length - 1 && !(source[i] === '*' && source[i + 1] === '/')) i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(source, i) - 1;
      continue;
    }

    if (ch === '{') {
      const counts = isControlBrace(source, i);
      stack.push(counts);
      if (counts) {
        depth++;
        if (depth > DEFAULT_THRESHOLD) {
          violations.push({
            rule: RULE_ID,
            line: lineOfIndex(source, i),
            severity: 'error',
            message: `max-depth > ${DEFAULT_THRESHOLD} (depth ${depth})`,
          });
        }
      }
    } else if (ch === '}') {
      if (stack.pop()) depth--;
    }
  }
  return violations;
}

module.exports = {
  id: RULE_ID,
  defaultThreshold: DEFAULT_THRESHOLD,
  check,
};
