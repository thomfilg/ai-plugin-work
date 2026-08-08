'use strict';

/**
 * shell-tokenize.js — a quote-aware reader for shell command text.
 *
 * This is deliberately NOT a shell. It answers one question: which words, in
 * which command segments, does this text contain? Control operators (`&&`,
 * `||`, `;`, `|`, newline, subshell parens) separate segments; quotes and
 * backslash escapes are honoured so `echo "a && b"` stays a single word.
 *
 * A quoted run is copied VERBATIM, newlines included, so a message written as
 * `"$(cat <<'EOF' … EOF)"` arrives as one token with its whole body intact —
 * the only reason the guard can read a heredoc at all.
 */

/** Characters that end a command segment when they appear outside quotes. */
const SEGMENT_BREAKS = new Set(['&', '|', ';', '\n', '(', ')']);

/** Characters that end a word without ending the segment. */
const WORD_BREAKS = new Set([' ', '\t', '\r']);

function asText(value) {
  return value == null ? '' : String(value);
}

/** Flush the in-progress word onto the current segment. */
function pushWord(state) {
  if (!state.open) return;
  state.tokens.push(state.word);
  state.word = '';
  state.open = false;
}

/** Flush the current segment onto the result. */
function pushSegment(state) {
  pushWord(state);
  if (state.tokens.length) state.segments.push(state.tokens);
  state.tokens = [];
}

/**
 * Copy a quoted run into the current word and return the index just past the
 * closing quote. An unterminated quote consumes the rest of the text rather
 * than throwing.
 */
function consumeQuoted(state, text, start) {
  const quote = text[start];
  state.open = true;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i];
    if (quote === '"' && ch === '\\' && i + 1 < text.length) {
      state.word += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    state.word += ch;
    i += 1;
  }
  return i;
}

/** Apply one character to the tokenizer state; returns the next index. */
function consumeChar(state, text, i) {
  const ch = text[i];
  if (ch === '\\' && i + 1 < text.length) {
    state.word += text[i + 1];
    state.open = true;
    return i + 2;
  }
  if (ch === "'" || ch === '"') return consumeQuoted(state, text, i);
  if (WORD_BREAKS.has(ch)) {
    pushWord(state);
    return i + 1;
  }
  if (SEGMENT_BREAKS.has(ch)) {
    pushSegment(state);
    // `&&` and `||` are two characters; `;`, `|`, `&` and a newline are one.
    return i + (text[i + 1] === ch ? 2 : 1);
  }
  state.word += ch;
  state.open = true;
  return i + 1;
}

/**
 * Split command text into segments of tokens.
 *
 * @param {string} command
 * @returns {string[][]}
 */
function tokenize(command) {
  const text = asText(command);
  const state = { segments: [], tokens: [], word: '', open: false };
  let i = 0;
  while (i < text.length) i = consumeChar(state, text, i);
  pushSegment(state);
  return state.segments;
}

/**
 * Value of a `--flag=value` / `--flag value` pair at `argv[i]`, or null.
 * Lives here with the other command-reading primitives so the git modules can
 * share it without depending on each other.
 */
function longFlagValue(argv, i, flag) {
  const token = argv[i];
  if (token === flag) return i + 1 < argv.length ? argv[i + 1] : null;
  if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  return null;
}

module.exports = { tokenize, asText, longFlagValue, SEGMENT_BREAKS, WORD_BREAKS };
