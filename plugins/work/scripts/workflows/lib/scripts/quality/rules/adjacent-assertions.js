'use strict';

/**
 * `adjacent-assertions` — flags consecutive duplicate assertion statements.
 *
 * Targets a recurring merge artifact: when a branch carries an assertion in
 * its long single-line form and another carries the same assertion
 * biome-wrapped across lines, conflict resolution (human or agent) keeps
 * BOTH copies. The pair survives every other gate — biome formats both
 * happily, the test still passes (assertions are idempotent), and jscpd's
 * 50-token floor ignores 2-line clones.
 *
 * Scope is deliberately narrow — statements starting with `assert`/`expect` —
 * because an adjacent identical assertion is rarely meaningful, while adjacent
 * identical *calls* can be (idempotency / accumulation tests). Statements are
 * compared whitespace-normalized so the wrapped and unwrapped shapes of the
 * same assertion match. Only blank lines may sit between the pair.
 *
 * Intentional repeats DO exist (asserting a stateful call twice — e.g. a
 * `/g`-flagged regex's lastIndex, or a fire-mode suppressor that must stay
 * false across calls). The escape hatch is the fix you'd want anyway: put a
 * comment between the repeats explaining WHY — a comment line breaks
 * adjacency, so the pair is not flagged, and the intent is documented.
 *
 * Pure JS, no external tool.
 */

const fs = require('node:fs');
const path = require('node:path');

const ASSERT_START_RE = /^(?:await\s+)?(?:assert[.(]|expect\s*\()/;
// A biome-formatted statement always terminates with `;` — cap the
// accumulation window so an unterminated match can't swallow the file.
const MAX_STATEMENT_LINES = 15;

/**
 * Strip whitespace OUTSIDE string literals so wrapped and single-line forms
 * compare equal — biome puts line breaks inside the argument list
 * (`match(\n  out,\n  …\n)`), so a collapsed-space compare would still differ
 * from the inline form. Whitespace inside `'`/`"`/`` ` `` literals is
 * semantic (`classify('')` vs `classify('   ')`) and must be preserved.
 * Escapes are honored; regex literals are not quote-tracked (an odd number
 * of quotes inside one could skew normalization of the remainder — accepted:
 * the worst case is a missed or spurious *comparison*, on already-adjacent
 * assertions).
 */
function isQuote(ch) {
  return ch === "'" || ch === '"' || ch === '`';
}

/**
 * Index of the closing quote for the literal opening at `start`; honors
 * backslash escapes. Unterminated literal → last index (copy the rest).
 */
function endOfQuoted(stmt, start) {
  const quote = stmt[start];
  for (let i = start + 1; i < stmt.length; i++) {
    if (stmt[i] === '\\') i++;
    else if (stmt[i] === quote) return i;
  }
  return stmt.length - 1;
}

function normalize(stmt) {
  let out = '';
  for (let i = 0; i < stmt.length; i++) {
    const ch = stmt[i];
    if (isQuote(ch)) {
      const end = endOfQuoted(stmt, i);
      out += stmt.slice(i, end + 1);
      i = end;
    } else if (!/\s/.test(ch)) {
      out += ch;
    }
  }
  return out;
}

/**
 * Extract assertion statements from a file's lines.
 * @returns {Array<{line: number, endIdx: number, text: string}>}
 *   `line` is 1-based start line; `endIdx` the 0-based index of the last line.
 */
function extractAssertions(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trim();
    if (!ASSERT_START_RE.test(trimmed)) {
      i++;
      continue;
    }
    let stmt = trimmed;
    let end = i;
    while (
      !/;\s*$/.test(lines[end].trim()) &&
      end - i < MAX_STATEMENT_LINES &&
      end < lines.length - 1
    ) {
      end++;
      stmt += ` ${lines[end].trim()}`;
    }
    out.push({ line: i + 1, endIdx: end, text: normalize(stmt) });
    i = end + 1;
  }
  return out;
}

/** True when every line strictly between the two statements is blank. */
function onlyBlankBetween(lines, prevEndIdx, nextStartLine) {
  for (let i = prevEndIdx + 1; i < nextStartLine - 1; i++) {
    if (lines[i].trim() !== '') return false;
  }
  return true;
}

function checkFile(absFile, repoRoot) {
  let source;
  try {
    source = fs.readFileSync(absFile, 'utf8');
  } catch {
    return [];
  }
  const lines = source.split('\n');
  const assertions = extractAssertions(lines);
  const violations = [];

  for (let i = 1; i < assertions.length; i++) {
    const prev = assertions[i - 1];
    const curr = assertions[i];
    if (prev.text !== curr.text) continue;
    if (!onlyBlankBetween(lines, prev.endIdx, curr.line)) continue;
    violations.push({
      file: path.relative(repoRoot, absFile).split(path.sep).join('/'),
      line: curr.line,
      rule: 'duplicate-adjacent-assertions',
      severity: 'error',
      message: `duplicate-adjacent-assertions — identical assertion already on line ${prev.line} (merge artifact; delete one copy)`,
    });
  }
  return violations;
}

function checkAll(absFiles, repoRoot) {
  if (!Array.isArray(absFiles)) return [];
  const violations = [];
  for (const f of absFiles) {
    if (!f.endsWith('.js')) continue;
    violations.push(...checkFile(f, repoRoot));
  }
  return violations;
}

module.exports = { checkAll };
