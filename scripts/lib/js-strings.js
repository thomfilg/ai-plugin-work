'use strict';

/**
 * js-strings — dependency-free scanner that extracts string/template literals
 * from JavaScript source WITH their enclosing call-expression identifiers.
 *
 * Built for scripts/lint-vocab.js: it needs to know whether a literal like
 * 'Use AskUserQuestion …' sits inside `renderQuestionText(…)` (rendered — OK)
 * or is emitted raw. It is a lexer, not a parser: comments and regex literals
 * are skipped, template interpolations are scanned as code (their text is not
 * part of the literal), and a stack of `identifier(`-frames approximates the
 * enclosing calls. Good enough for lint scope files; not a general JS parser.
 */

const IDENT_RE = /[A-Za-z0-9_$]/;
// Chars after which a `/` starts a REGEX literal, not division (standard
// operand-position heuristic).
const REGEX_PREFIX_RE = /[({[,;:=!&|?+\-*%<>~^]/;
// Keywords after which a `/` is also a regex (`return /x/.test(y)`).
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'instanceof',
  'do',
  'else',
  'yield',
  'await',
]);

function newState(src) {
  return { src, i: 0, line: 1, calls: [], lastIdent: null, lastMeaningful: '', out: [] };
}

function bumpLines(st, text) {
  for (let k = 0; k < text.length; k++) {
    if (text[k] === '\n') st.line += 1;
  }
}

/** Read a '…' or "…" literal starting at st.i; returns its raw content. */
function readQuoted(st, quote) {
  let content = '';
  st.i += 1;
  while (st.i < st.src.length) {
    const c = st.src[st.i];
    if (c === '\\') {
      content += st.src.slice(st.i, st.i + 2);
      st.i += 2;
      continue;
    }
    st.i += 1;
    if (c === quote) break;
    content += c;
  }
  return content;
}

/** Skip a `${…}` template interpolation (handles nested strings/braces). */
function skipInterpolation(st) {
  st.i += 2; // past "${"
  let depth = 1;
  while (st.i < st.src.length && depth > 0) {
    const c = st.src[st.i];
    if (c === "'" || c === '"') {
      bumpLines(st, readQuoted(st, c));
      continue;
    }
    if (c === '`') {
      readTemplate(st); // nested template — its text is not our content
      continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') depth -= 1;
    if (c === '\n') st.line += 1;
    st.i += 1;
  }
}

/** Read a `…` template literal; returns its TEXT chunks (interps skipped). */
function readTemplate(st) {
  const startLine = st.line;
  let content = '';
  st.i += 1;
  while (st.i < st.src.length) {
    const c = st.src[st.i];
    if (c === '\\') {
      content += st.src.slice(st.i, st.i + 2);
      bumpLines(st, st.src.slice(st.i, st.i + 2));
      st.i += 2;
      continue;
    }
    if (c === '`') {
      st.i += 1;
      break;
    }
    if (c === '$' && st.src[st.i + 1] === '{') {
      content += ' '; // keep word boundaries across interpolations
      skipInterpolation(st);
      continue;
    }
    if (c === '\n') st.line += 1;
    content += c;
    st.i += 1;
  }
  st.out.push({ content, line: startLine, calls: [...st.calls] });
  st.lastIdent = null;
  st.lastMeaningful = '`';
}

function skipLineComment(st) {
  while (st.i < st.src.length && st.src[st.i] !== '\n') st.i += 1;
}

function skipBlockComment(st) {
  st.i += 2;
  while (st.i < st.src.length && !(st.src[st.i] === '*' && st.src[st.i + 1] === '/')) {
    if (st.src[st.i] === '\n') st.line += 1;
    st.i += 1;
  }
  st.i += 2;
}

/** Skip a regex literal (handles escapes and character classes). */
function skipRegex(st) {
  st.i += 1;
  let inClass = false;
  while (st.i < st.src.length) {
    const c = st.src[st.i];
    st.i += 1;
    if (c === '\\') {
      st.i += 1;
    } else if (c === '[') {
      inClass = true;
    } else if (c === ']') {
      inClass = false;
    } else if (c === '/' && !inClass) {
      break;
    } else if (c === '\n') {
      break; // not a regex after all — bail without consuming the line
    }
  }
}

function isRegexPosition(st) {
  if (st.lastIdent !== null && REGEX_KEYWORDS.has(st.lastIdent)) return true;
  return st.lastMeaningful === '' || REGEX_PREFIX_RE.test(st.lastMeaningful);
}

function readIdent(st) {
  let ident = '';
  while (st.i < st.src.length && IDENT_RE.test(st.src[st.i])) {
    ident += st.src[st.i];
    st.i += 1;
  }
  st.lastIdent = ident;
  st.lastMeaningful = ident[ident.length - 1];
}

function handleSlash(st) {
  const next = st.src[st.i + 1];
  if (next === '/') skipLineComment(st);
  else if (next === '*') skipBlockComment(st);
  else if (isRegexPosition(st)) skipRegex(st);
  else {
    st.lastMeaningful = '/';
    st.lastIdent = null;
    st.i += 1;
  }
}

function handleParen(st, c) {
  if (c === '(') st.calls.push(st.lastIdent);
  else if (st.calls.length > 0) st.calls.pop();
  st.lastIdent = null;
  st.lastMeaningful = c;
  st.i += 1;
}

function handleOther(st, c) {
  if (c === '\n') st.line += 1;
  if (!/\s/.test(c)) {
    st.lastIdent = null;
    st.lastMeaningful = c;
  }
  st.i += 1;
}

function step(st) {
  const c = st.src[st.i];
  if (c === '/') return handleSlash(st);
  if (c === "'" || c === '"') {
    const line = st.line;
    const content = readQuoted(st, c);
    bumpLines(st, content);
    st.out.push({ content, line, calls: [...st.calls] });
    st.lastMeaningful = c;
    st.lastIdent = null;
    return undefined;
  }
  if (c === '`') return readTemplate(st);
  if (c === '(' || c === ')') return handleParen(st, c);
  if (IDENT_RE.test(c)) return readIdent(st);
  return handleOther(st, c);
}

/**
 * @param {string} source JavaScript source text
 * @returns {Array<{content: string, line: number, calls: (string|null)[]}>}
 *   every string/template literal with its 1-based start line and the
 *   identifiers of the call expressions enclosing it (innermost last).
 */
function scanStrings(source) {
  const st = newState(source);
  while (st.i < st.src.length) step(st);
  return st.out;
}

module.exports = { scanStrings };
