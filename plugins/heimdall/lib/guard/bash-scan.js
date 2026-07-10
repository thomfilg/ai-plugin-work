'use strict';

/**
 * Quote-aware shell scanner (GH-699). Parses one command string into pipeline/
 * list SEGMENTS of tokens, plus redirect targets, executed substrings
 * ($(…)/backticks → `nested`), and heredoc bodies. Returns null for any
 * construct the model does not cover (process substitution, unbalanced quotes,
 * stacked heredocs) so the caller falls back to the legacy fail-closed matcher.
 *
 * Each token records: raw (verbatim), dq (quote-flattened literal, with SUBST
 * placeholders where a $VAR/$()/backtick made it unresolvable), hadQuote,
 * hasSubst, hasGlob. The state machine lives in one Scanner object so each
 * construct handler stays small and independently testable.
 */

const MAX_COMMAND_LENGTH = 20000;

// Placeholder marking an unresolvable substitution inside a token. NUL cannot
// appear in real shell input, so it never collides with data.
const SUBST_CHAR = '\u0000';
const SUBST_RE = /\u0000/g;

const DONE = Symbol('unparseable');

function newTok() {
  return { raw: '', dq: '', hadQuote: false, hasSubst: false, hasGlob: false };
}

class Scanner {
  constructor(text) {
    this.text = text;
    this.i = 0;
    this.segments = [];
    this.nested = [];
    this.seg = { tokens: [], redirects: [], heredocs: [] };
    this.tok = null;
    this.pendingRedirect = null;
  }

  startTok() {
    if (!this.tok) this.tok = newTok();
  }

  endTok() {
    if (!this.tok) return;
    if (this.pendingRedirect) {
      this.seg.redirects.push({ op: this.pendingRedirect, target: this.tok });
      this.pendingRedirect = null;
    } else {
      this.seg.tokens.push(this.tok);
    }
    this.tok = null;
  }

  endSeg() {
    this.endTok();
    const s = this.seg;
    if (s.tokens.length || s.redirects.length || s.heredocs.length) this.segments.push(s);
    this.seg = { tokens: [], redirects: [], heredocs: [] };
  }

  markSubst() {
    this.startTok();
    this.tok.dq += SUBST_CHAR;
    this.tok.hasSubst = true;
  }

  // Scan a $(…) body (nesting + single-quote aware). Pushes the body to
  // `nested` and returns the index past the closing paren, or -1 (unbalanced).
  scanDollarParen(start) {
    const { text } = this;
    let depth = 1;
    let j = start;
    while (j < text.length && depth > 0) {
      const c = text[j];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (c === "'") {
        j = text.indexOf("'", j + 1);
        if (j === -1) return -1;
      }
      j += 1;
    }
    if (depth !== 0) return -1;
    this.nested.push(text.slice(start, j - 1));
    return j;
  }
}

// ─── Construct handlers: each returns DONE on an unmodeled construct ──────────
// Shared low-level consumers assume sc.tok exists and append to it, so the
// top-level (startTok first) and in-double-quote callers reuse one body.

// Consume `$(…)` at sc.i, recording the body as executed. Returns null | DONE.
function absorbDollarParen(sc) {
  if (sc.text[sc.i + 2] === '(') return DONE; // arithmetic $((…)) — not modeled
  const past = sc.scanDollarParen(sc.i + 2);
  if (past === -1) return DONE;
  sc.tok.raw += sc.text.slice(sc.i, past);
  sc.tok.dq += SUBST_CHAR;
  sc.tok.hasSubst = true;
  sc.i = past;
  return null;
}

// Consume a `…` backtick run at sc.i, recording the body as executed.
function absorbBacktick(sc) {
  const close = sc.text.indexOf('`', sc.i + 1);
  if (close === -1) return DONE;
  sc.nested.push(sc.text.slice(sc.i + 1, close));
  sc.tok.raw += sc.text.slice(sc.i, close + 1);
  sc.tok.dq += SUBST_CHAR;
  sc.tok.hasSubst = true;
  sc.i = close + 1;
  return null;
}

function handleSingleQuote(sc) {
  const close = sc.text.indexOf("'", sc.i + 1);
  if (close === -1) return DONE;
  sc.startTok();
  sc.tok.raw += sc.text.slice(sc.i, close + 1);
  sc.tok.dq += sc.text.slice(sc.i + 1, close);
  sc.tok.hadQuote = true;
  sc.i = close + 1;
  return null;
}

function dqBackslash(sc) {
  sc.tok.raw += sc.text.slice(sc.i, sc.i + 2);
  sc.tok.dq += sc.text[sc.i + 1];
  sc.i += 2;
  return null;
}
function dqVar(sc) {
  const { text } = sc;
  sc.tok.raw += '$';
  sc.tok.dq += SUBST_CHAR;
  sc.tok.hasSubst = true;
  sc.i += 1;
  while (sc.i < text.length && /[A-Za-z0-9_{}]/.test(text[sc.i]) && text[sc.i] !== '"') {
    sc.tok.raw += text[sc.i];
    sc.i += 1;
  }
  return null;
}
function dqPlain(sc) {
  sc.tok.raw += sc.text[sc.i];
  sc.tok.dq += sc.text[sc.i];
  sc.i += 1;
  return null;
}

// One character inside a double-quoted run. Returns DONE on an unbalanced
// inner substitution, else null.
function doubleQuoteChar(sc) {
  const { text, i } = sc;
  if (text[i] === '\\' && i + 1 < text.length) return dqBackslash(sc);
  if (text.slice(i, i + 2) === '$(') return absorbDollarParen(sc);
  if (text[i] === '`') return absorbBacktick(sc);
  if (text[i] === '$') return dqVar(sc);
  return dqPlain(sc);
}

function handleDoubleQuote(sc) {
  sc.startTok();
  sc.tok.hadQuote = true;
  sc.tok.raw += '"';
  sc.i += 1;
  while (sc.i < sc.text.length && sc.text[sc.i] !== '"') {
    if (doubleQuoteChar(sc) === DONE) return DONE;
  }
  if (sc.i >= sc.text.length) return DONE; // unbalanced
  sc.tok.raw += '"';
  sc.i += 1;
  return null;
}

function handleBackslash(sc) {
  if (sc.i + 1 >= sc.text.length) return DONE;
  sc.startTok();
  return dqBackslash(sc); // same escape-append body as inside double quotes
}

function handleDollarParen(sc) {
  sc.startTok();
  return absorbDollarParen(sc);
}

function handleBacktick(sc) {
  sc.startTok();
  return absorbBacktick(sc);
}

function handleDollar(sc) {
  const { text } = sc;
  sc.markSubst();
  sc.tok.raw += '$';
  sc.i += 1;
  if (text[sc.i] === '{') {
    const close = text.indexOf('}', sc.i);
    if (close === -1) return DONE;
    sc.tok.raw += text.slice(sc.i, close + 1);
    sc.i = close + 1;
  } else {
    while (sc.i < text.length && /[A-Za-z0-9_]/.test(text[sc.i])) {
      sc.tok.raw += text[sc.i];
      sc.i += 1;
    }
  }
  return null;
}

// Merge a heredoc: record its body, then splice the rest-of-line command with
// everything after the body and re-scan so downstream segments are preserved.
function handleHeredoc(sc, m) {
  const { text } = sc;
  const lineEnd = text.indexOf('\n', sc.i);
  if (lineEnd === -1) {
    sc.i += m[0].length; // `<<'EOF'` at EOF — no body executes
    return null;
  }
  const delim = m[2];
  const bodyStart = lineEnd + 1;
  const endM = new RegExp(`^\\s*${delim}\\s*$`, 'm').exec(text.slice(bodyStart));
  const bodyEnd = endM ? bodyStart + endM.index : text.length;
  sc.seg.heredocs.push({ body: text.slice(bodyStart, bodyEnd) });
  if (sc.seg.heredocs.length > 1) return DONE; // stacked heredocs — not modeled
  const rest = text.slice(sc.i + m[0].length, lineEnd);
  const after = endM ? bodyStart + endM.index + endM[0].length : text.length;
  const sub = scanCommand(rest + '\n' + text.slice(after));
  if (!sub) return DONE;
  sc.endTok();
  mergeHeredocTail(sc, sub);
  return sub;
}

function mergeHeredocTail(sc, sub) {
  if (sub.segments.length) {
    const first = sub.segments[0];
    sc.seg.tokens.push(...first.tokens);
    sc.seg.redirects.push(...first.redirects);
    sc.seg.heredocs.push(...first.heredocs);
    sc.endSeg();
    sc.segments.push(...sub.segments.slice(1));
  } else {
    sc.endSeg();
  }
  sc.nested.push(...sub.nested);
}

// A redirect operator (or fd-dup). Consumes it; leaves a pendingRedirect for
// the target token, or skips a read-redirect source. Returns DONE on a
// malformed sequence, 'handled', or null when it was not a redirect.
function handleRedirect(sc) {
  const rest = sc.text.slice(sc.i);
  const dup = /^\d*>&\d*-?/.exec(rest);
  if (dup && dup[0].length > 2) {
    sc.endTok();
    sc.i += dup[0].length; // fd duplication — no file target
    return 'handled';
  }
  const redir = /^(\d*(?:>>|>\||>)|&>>|&>|<)/.exec(rest);
  if (!redir) return null;
  sc.endTok();
  if (sc.pendingRedirect) return DONE;
  if (redir[1] === '<') {
    sc.i += redir[0].length;
    while (sc.i < sc.text.length && /\s/.test(sc.text[sc.i])) sc.i += 1;
    while (sc.i < sc.text.length && !/[\s|&;<>]/.test(sc.text[sc.i])) sc.i += 1;
    return 'handled';
  }
  sc.pendingRedirect = redir[1];
  sc.i += redir[0].length;
  return 'handled';
}

const ONE_CHAR_SEP_RE = /[;|&\n()]/;

// Statement separators and grouping parens. Returns DONE, 'handled', or null.
function handleSeparator(sc) {
  const two = sc.text.slice(sc.i, sc.i + 2);
  const isTwo = two === '&&' || two === '||';
  if (!isTwo && !ONE_CHAR_SEP_RE.test(sc.text[sc.i])) return null;
  if (sc.pendingRedirect) return DONE;
  sc.endSeg();
  sc.i += isTwo ? 2 : 1;
  return 'handled';
}

function handleDefault(sc) {
  const c = sc.text[sc.i];
  if (/\s/.test(c)) {
    sc.endTok();
    sc.i += 1;
    return;
  }
  if (c === '#' && !sc.tok) {
    const nl = sc.text.indexOf('\n', sc.i);
    sc.i = nl === -1 ? sc.text.length : nl;
    return;
  }
  sc.startTok();
  sc.tok.raw += c;
  sc.tok.dq += c;
  if (c === '*' || c === '?' || c === '[') sc.tok.hasGlob = true;
  sc.i += 1;
}

const MISS = Symbol('miss');
const HEREDOC_RE = /^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

// Quote/substitution constructs. Returns DONE, null (handled), or MISS.
function stepQuoteLike(sc) {
  const { text, i } = sc;
  const c = text[i];
  const two = text.slice(i, i + 2);
  if (c === "'") return handleSingleQuote(sc);
  if (c === '"') return handleDoubleQuote(sc);
  if (c === '\\') return handleBackslash(sc);
  if (two === '$(') return handleDollarParen(sc);
  if (c === '`') return handleBacktick(sc);
  if (c === '$') return handleDollar(sc);
  if (two === '<(' || two === '>(') return DONE; // process substitution
  return MISS;
}

// Heredocs and redirects. Returns DONE, a heredoc splice result, null, or MISS.
function stepRedirects(sc) {
  const heredoc = HEREDOC_RE.exec(sc.text.slice(sc.i));
  if (heredoc) return handleHeredoc(sc, heredoc);
  const redir = handleRedirect(sc);
  if (redir === DONE) return DONE;
  if (redir === 'handled') return null;
  return MISS;
}

// Dispatch one construct at the cursor. Returns DONE, a completed sub-result
// (heredoc splice), or null to continue.
function step(sc) {
  const q = stepQuoteLike(sc);
  if (q !== MISS) return q;
  const r = stepRedirects(sc);
  if (r !== MISS) return r;
  const sep = handleSeparator(sc);
  if (sep === DONE) return DONE;
  if (sep === 'handled') return null;
  handleDefault(sc);
  return null;
}

function scanCommand(text) {
  if (typeof text !== 'string' || text.length > MAX_COMMAND_LENGTH) return null;
  const sc = new Scanner(text);
  while (sc.i < text.length) {
    const r = step(sc);
    if (r === DONE) return null;
    if (r && typeof r === 'object') return r; // heredoc splice completed the scan
  }
  sc.endSeg(); // flush a trailing redirect target too
  if (sc.pendingRedirect) return null; // dangling redirect at EOF
  return { segments: sc.segments, nested: sc.nested };
}

module.exports = { scanCommand, SUBST_CHAR, SUBST_RE, MAX_COMMAND_LENGTH };
