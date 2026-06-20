'use strict';

/**
 * lib/dispatcher-helpers.js — pure tokenization/parsing helpers split out of
 * command-existence-dispatcher.js (GH-590) to keep the dispatcher under the
 * 400-line max-lines threshold. No I/O, no side effects.
 */

function stripQuotes(s) {
  if (s.length >= 2) {
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function _isWhitespace(ch) {
  return ch === ' ' || ch === '\t';
}

function _pushToken(out, buf) {
  if (buf.length > 0) out.push(buf);
  return '';
}

function _tryConsumeEscape(state, ch) {
  if (state.escaped) {
    state.buf += ch;
    state.escaped = false;
    return true;
  }
  if (ch === '\\' && !state.inSingle) {
    state.escaped = true;
    return true;
  }
  return false;
}

function _tryConsumeQuote(state, ch) {
  if (ch === "'" && !state.inDouble) {
    state.inSingle = !state.inSingle;
    state.buf += ch;
    return true;
  }
  if (ch === '"' && !state.inSingle) {
    state.inDouble = !state.inDouble;
    state.buf += ch;
    return true;
  }
  return false;
}

function _stepArgvChar(state, ch) {
  if (_tryConsumeEscape(state, ch)) return;
  if (_tryConsumeQuote(state, ch)) return;
  if (!state.inSingle && !state.inDouble && _isWhitespace(ch)) {
    state.buf = _pushToken(state.out, state.buf);
    return;
  }
  state.buf += ch;
}

function argvSplit(segment) {
  const state = { out: [], buf: '', inSingle: false, inDouble: false, escaped: false };
  for (let i = 0; i < segment.length; i += 1) {
    _stepArgvChar(state, segment[i]);
  }
  _pushToken(state.out, state.buf);
  return state.out;
}

function _isVarStartAt(s, i) {
  if (s[i] !== '$' || i + 1 >= s.length) return false;
  const next = s[i + 1];
  return next === '{' || /[A-Za-z_]/.test(next);
}

function containsVarRef(s) {
  let inSingle = false;
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && _isVarStartAt(s, i)) return true;
  }
  return false;
}

function extractFirstVarName(s) {
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] !== '$') continue;
    if (s[i + 1] === '{') {
      const close = s.indexOf('}', i + 2);
      if (close === -1) continue;
      return s.slice(i + 2, close);
    }
    let j = i + 1;
    while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j += 1;
    if (j > i + 1) return s.slice(i + 1, j);
  }
  return null;
}

module.exports = {
  stripQuotes,
  argvSplit,
  containsVarRef,
  extractFirstVarName,
};
