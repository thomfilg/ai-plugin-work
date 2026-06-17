/**
 * lib/shell-tokenizer.js — quote-aware shell command tokenizer (GH-590 task2).
 *
 * Public API:
 *   tokenize(cmd) -> Token[]            // Token = { kind: 'segment'|'op', value: string }
 *   splitTopLevelCommands(cmd) -> string[]
 *
 * Implementation is a single-pass character state-machine. NO regex is used.
 * Honors double-quoted ("..."), single-quoted ('...'), and backslash-escape
 * contexts so that the shell operators &&, ||, ;, | embedded inside quotes
 * are NOT treated as splits.
 */

'use strict';

const SINGLE_QUOTE = "'";
const DOUBLE_QUOTE = '"';
const BACKSLASH = '\\';

/**
 * Walk one character forward and update quote/escape state.
 * Returns the next state object: { inSingle, inDouble, escaped }.
 */
function advanceQuoteState(ch, state) {
  if (state.escaped) {
    return { inSingle: state.inSingle, inDouble: state.inDouble, escaped: false };
  }
  if (state.inSingle) {
    if (ch === SINGLE_QUOTE) {
      return { inSingle: false, inDouble: false, escaped: false };
    }
    return state;
  }
  if (state.inDouble) {
    if (ch === BACKSLASH) {
      return { inSingle: false, inDouble: true, escaped: true };
    }
    if (ch === DOUBLE_QUOTE) {
      return { inSingle: false, inDouble: false, escaped: false };
    }
    return state;
  }
  if (ch === BACKSLASH) {
    return { inSingle: false, inDouble: false, escaped: true };
  }
  if (ch === SINGLE_QUOTE) {
    return { inSingle: true, inDouble: false, escaped: false };
  }
  if (ch === DOUBLE_QUOTE) {
    return { inSingle: false, inDouble: true, escaped: false };
  }
  return state;
}

function isTopLevel(state) {
  return !state.inSingle && !state.inDouble && !state.escaped;
}

/**
 * Match a top-level shell operator starting at position i.
 * Returns { op: string, length: number } or null when no operator matches.
 * Operators: '&&', '||', '|', ';'  (single '&' / single '|' that is part of
 * the two-char form is handled by checking two-char operators first).
 */
function matchOperator(cmd, i) {
  const ch = cmd[i];
  const next = cmd[i + 1];
  if (ch === '&' && next === '&') return { op: '&&', length: 2 };
  if (ch === '|' && next === '|') return { op: '||', length: 2 };
  if (ch === '|') return { op: '|', length: 1 };
  if (ch === ';') return { op: ';', length: 1 };
  return null;
}

/**
 * Tokenize `cmd` into an alternating sequence of segment / op tokens.
 * Segments preserve the original whitespace; callers may trim as needed.
 */
function tokenize(cmd) {
  const tokens = [];
  let buf = '';
  let quoteState = { inSingle: false, inDouble: false, escaped: false };

  let i = 0;
  while (i < cmd.length) {
    if (isTopLevel(quoteState)) {
      const opMatch = matchOperator(cmd, i);
      if (opMatch) {
        if (buf.length > 0) tokens.push({ kind: 'segment', value: buf });
        tokens.push({ kind: 'op', value: opMatch.op });
        buf = '';
        i += opMatch.length;
        continue;
      }
    }
    const ch = cmd[i];
    buf += ch;
    quoteState = advanceQuoteState(ch, quoteState);
    i += 1;
  }
  if (buf.length > 0) tokens.push({ kind: 'segment', value: buf });
  return tokens;
}

/**
 * Split `cmd` at top-level shell operators (&&, ||, ;, |) honoring quotes.
 * Returns trimmed string segments (no operators). Empty segments are dropped.
 */
function splitTopLevelCommands(cmd) {
  return tokenize(cmd)
    .filter((t) => t.kind === 'segment')
    .map((t) => t.value.trim())
    .filter((s) => s.length > 0);
}

module.exports = {
  tokenize,
  splitTopLevelCommands,
};
