/**
 * red-load-failure.js
 *
 * Shared heuristic for detecting RED-phase load failures: test runs whose
 * non-zero exit reflects a load-time error (ReferenceError / SyntaxError /
 * missing module) or a runner that executed zero tests, rather than a real
 * assertion failure. Accepting such runs as RED wedges the subsequent GREEN
 * because the same crash repeats regardless of source edits (see GH-508
 * Task 6, fixed by GH-532).
 *
 * Extracted as a standalone module in anticipation of reuse by
 * `enforce-tdd-on-stop.js` and similar future consumers, so the patterns
 * and scan semantics are not copy-pasted when that work lands. Today the
 * only importer is `tdd-phase-state.js record-red`.
 *
 * RUNNER ASSUMPTION — node:test ONLY:
 *   The detector assumes node:test TAP output shape, where failing-test
 *   diagnostics are wrapped in `---` / `...` YAML envelopes. The YAML guard
 *   in `shouldSkipLine` is what prevents a real failing test whose body
 *   throws `ReferenceError` (emitted by the runner under `error: |-`) from
 *   being misclassified as a load failure.
 *
 *   jest / vitest / mocha do NOT emit those envelopes. A real failing test
 *   under those runners that throws `ReferenceError:` / `SyntaxError:`
 *   would be falsely rejected here. Today the repo is node:test-only (see
 *   `plugins/work/CLAUDE.md` → "Node built-in test runner"), so this is
 *   acceptable.
 *
 *   If support for jest / vitest / mocha is ever added, the heuristic must
 *   be revised to require the load-failure signature to appear BEFORE the
 *   first `TAP version` line (i.e. during test-file load, before the
 *   runner has started reporting). Until then, do not reuse this module
 *   against output from other runners.
 */

const RED_LOAD_FAILURE_PATTERNS = Object.freeze([
  Object.freeze({ name: 'ReferenceError', regex: /\bReferenceError:/ }),
  Object.freeze({ name: 'SyntaxError', regex: /\bSyntaxError:/ }),
  // Split into two named patterns so the audit row's `meta.signature` always
  // names a substring that actually appears in `meta.snippet`. The shared
  // diagnostic message in `formatRedLoadFailureDiagnostic` covers both.
  Object.freeze({ name: 'Cannot find module', regex: /Cannot find module/ }),
  Object.freeze({ name: 'MODULE_NOT_FOUND', regex: /MODULE_NOT_FOUND/ }),
  // Match only the node:test TAP summary line: `# tests 0` anchored at the
  // start of a line. A loose `\b0\s+tests?\b` alternative would false-positive
  // on legitimate `not ok` lines whose test name contains the phrase
  // "0 tests" (e.g. `not ok 1 - returns 0 tests when input is empty`).
  Object.freeze({ name: '0 tests', regex: /^#\s*tests\s+0\b/ }),
]);

/**
 * Top-level TAP lines that embed a user-supplied test name. A failing test
 * named `throws ReferenceError: when given bad arg` emits one of these
 * lines at column 0 — that is NOT a load failure, it is a normal
 * assertion failure. The detector must skip these lines before signature
 * matching so symmetric coverage with the `# tests 0` anchor is achieved
 * for the other patterns.
 *
 * Only the *name-embedding* TAP lines are skipped:
 *   - `not ok N - <name>`
 *   - `ok N - <name>`
 *   - `# Subtest: <name>`
 *
 * The `# tests N`, `# pass N`, `# fail N`, `# suites N`, `# skipped N`,
 * `# todo N`, `# duration_ms ...` summary lines are NOT skipped — they
 * carry fixed labels from node:test (never user names) and the `0 tests`
 * pattern relies on `# tests 0` flowing through.
 */
const TAP_CONTROL_LINE_RE = /^(?:not ok\b|ok\b|# Subtest\b)/;

/**
 * Returns true if `line` closes a `details:` block opened at `baseIndent`.
 * A details block ends on a blank line, on the YAML doc-end `...`, or when
 * indentation returns to the heading column or earlier.
 *
 * @param {string} line raw output line
 * @param {number} baseIndent column of the opening `details:` heading
 * @returns {boolean}
 */
function closesDetailsBlock(line, baseIndent) {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed === '...') return true;
  const indentMatch = line.match(/^(\s*)\S/);
  const indent = indentMatch ? indentMatch[1].length : -1;
  return indent <= baseIndent;
}

/**
 * Scan a single line against every RED-load-failure pattern.
 *
 * @param {string} line raw output line
 * @returns {{ matched: boolean, signature: string|null }}
 */
function matchLoadFailureSignature(line) {
  for (const pattern of RED_LOAD_FAILURE_PATTERNS) {
    if (pattern.regex.test(line)) {
      return { matched: true, signature: pattern.name };
    }
  }
  return { matched: false, signature: null };
}

/**
 * State-machine predicate: should this line be skipped by the scanner?
 *
 * Lines skipped:
 *   - stack frames matching /^\s+at\s/ — a `ReferenceError:` thrown inside
 *     a passing test's `assert.throws` reports the type name on a stack
 *     frame; we don't want that to count as a top-level load failure.
 *   - lines inside an indented node:test YAML diagnostic block, bracketed
 *     by an indented `---` (open) and an indented `...` (close). A failing
 *     test's `error: |-` payload may literally include `ReferenceError:`
 *     (when the test body raised one); that is a real RED, not a load
 *     failure. Top-level (unindented) `---` / `...` lines do NOT open or
 *     close YAML — they're just dividers in test output (Bug 9).
 *   - lines inside a contiguous `details:` block — kept as a defensive
 *     fallback for runners that emit `details:` outside the YAML envelope.
 *
 * Mutates `state` in place.
 *
 * @param {string} line raw output line
 * @param {{ inYamlBlock: boolean, inDetailsBlock: boolean, detailsBaseIndent: number }} state
 * @returns {boolean} true if the line should be skipped
 */
function shouldSkipLine(line, state) {
  if (/^\s+at\s/.test(line)) return true;
  // Skip TAP control lines so a user-supplied test name embedding
  // `ReferenceError:` / `SyntaxError:` / `MODULE_NOT_FOUND` does not
  // trigger a false-positive load-failure match. Symmetric with the
  // anchored `^#\s*tests\s+0` guard for the `0 tests` signature.
  if (TAP_CONTROL_LINE_RE.test(line)) return true;
  // TAP YAML envelopes are ALWAYS indented under the preceding `not ok` line.
  // Require leading whitespace for the `---` opener and the `...` closer so a
  // top-level, unindented `---` in test output (a divider, a meta-test
  // fixture) does NOT silently swallow a real load-failure signature that
  // follows it (Bug 9).
  if (state.inYamlBlock) {
    if (/^\s+\.\.\.\s*$/.test(line)) state.inYamlBlock = false;
    return true;
  }
  if (/^\s+---\s*$/.test(line)) {
    state.inYamlBlock = true;
    return true;
  }
  if (state.inDetailsBlock) {
    if (closesDetailsBlock(line, state.detailsBaseIndent)) {
      state.inDetailsBlock = false;
      state.detailsBaseIndent = -1;
      // fall through — current line is past the block
    } else {
      return true;
    }
  }
  if (/^\s*details:\s*$/.test(line)) {
    state.inDetailsBlock = true;
    state.detailsBaseIndent = line.match(/^(\s*)/)[1].length;
    return true;
  }
  return false;
}

/**
 * Scan a single string (stdout OR stderr — never the concatenation) for a
 * load-failure signature. Returns the matched line alongside the signature
 * so the audit row's `meta.snippet` can quote exactly the line the detector
 * matched, not a heuristic re-scan that may disagree (Bug 6).
 *
 * The scan is total over `string` (string split + regex test + integer
 * indexes don't throw), so there is no try/catch fail-closed branch — a
 * defensive catch here would be unreachable and pollute the audit row's
 * `signature` field with a `'scan-error'` value no upstream consumer
 * matches against (Bug 8).
 *
 * @param {string} stream a single stream's contents
 * @returns {{ matched: boolean, signature: string|null, line: string|null }}
 */
function scanStream(stream) {
  if (typeof stream !== 'string' || stream.length === 0) {
    return { matched: false, signature: null, line: null };
  }
  const state = { inYamlBlock: false, inDetailsBlock: false, detailsBaseIndent: -1 };
  for (const line of stream.split(/\r?\n/)) {
    if (shouldSkipLine(line, state)) continue;
    const hit = matchLoadFailureSignature(line);
    if (hit.matched) {
      return { matched: true, signature: hit.signature, line };
    }
  }
  return { matched: false, signature: null, line: null };
}

/**
 * Detect a RED-load failure across stdout and stderr. Each stream is scanned
 * INDEPENDENTLY so an unclosed YAML envelope at the end of a truncated stdout
 * cannot leak `inYamlBlock=true` state across the seam and silently swallow
 * a real load-failure signature on stderr (Bug 7).
 *
 * Accepts either:
 *   - a single string (legacy callers): treated as stdout.
 *   - an object `{ stdout, stderr }`: scanned independently; stdout wins ties.
 *
 * @param {string | { stdout?: string, stderr?: string }} output
 * @returns {{ matched: boolean, signature: string|null, line: string|null }}
 */
function detectRedLoadFailure(output) {
  const streams =
    typeof output === 'string' ? [output] : [output && output.stdout, output && output.stderr];
  for (const stream of streams) {
    const hit = scanStream(stream);
    if (hit.matched) return hit;
  }
  return { matched: false, signature: null, line: null };
}

/**
 * Trim and cap a detector-matched line for use as the audit row's
 * `meta.snippet`. Callers MUST pass the line returned by
 * `detectRedLoadFailure(...).line` so the snippet quotes exactly what the
 * detector matched — not a second independent scan that may disagree on
 * which line triggered (Bug 6).
 *
 * @param {string|null|undefined} matchedLine the `.line` field from detectRedLoadFailure
 * @returns {string}
 */
function extractLoadFailureSnippet(matchedLine) {
  const MAX = 200;
  if (typeof matchedLine !== 'string' || matchedLine.length === 0) return '';
  return matchedLine.trim().slice(0, MAX);
}

module.exports = {
  RED_LOAD_FAILURE_PATTERNS,
  detectRedLoadFailure,
  extractLoadFailureSnippet,
};
