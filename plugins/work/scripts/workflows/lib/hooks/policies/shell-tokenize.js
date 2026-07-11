/**
 * policies/shell-tokenize.js
 *
 * Quote-aware shell tokenizer for the strict terminal-bypass parser.
 * Extracted verbatim from state-script-gate.js (file-size burndown, GH-695
 * change set) — behavior unchanged; state-script-gate re-exports it so
 * existing consumers keep their import path.
 */

/**
 * Quote-aware shell tokenizer for the strict bypass parser.
 *
 * Splits on whitespace EXCEPT within balanced ASCII single or double quotes,
 * so paths containing spaces (e.g. `/Users/John Smith/...`) remain a single
 * token. Surrounding quotes are stripped from each token before return.
 *
 * Rejects (returns null) on:
 *   - Unbalanced quotes (open `"` or `'` with no matching close).
 *   - Nested/mixed quotes within a token are simply treated literally — we do
 *     not support shell-style escaping (`\"`, `$'..'`, etc.); the bypass is
 *     for the orchestrator's strict, direct invocation only.
 *
 * @param {string} input
 * @returns {string[] | null}
 */
function shellTokenize(input) {
  const tokens = [];
  let current = '';
  let inToken = false;
  let quote = null; // either '"' or "'" when inside a quoted run

  for (let idx = 0; idx < input.length; idx++) {
    const ch = input[idx];

    if (quote) {
      if (ch === quote) {
        quote = null; // close quote — token continues (allows `a"b"c` style)
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }

    current += ch;
    inToken = true;
  }

  if (quote) return null; // unbalanced
  if (inToken) tokens.push(current);
  return tokens;
}

module.exports = { shellTokenize };
