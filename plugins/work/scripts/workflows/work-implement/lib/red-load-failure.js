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
 * Exported so `tdd-phase-state.js record-red` and future consumers
 * (e.g. `enforce-tdd-on-stop.js`) share the exact patterns and scan
 * semantics without copy-paste drift.
 */

const RED_LOAD_FAILURE_PATTERNS = Object.freeze([
  Object.freeze({ name: 'ReferenceError', regex: /\bReferenceError:/ }),
  Object.freeze({ name: 'SyntaxError', regex: /\bSyntaxError:/ }),
  Object.freeze({
    name: 'Cannot find module',
    regex: /Cannot find module|MODULE_NOT_FOUND/,
  }),
  Object.freeze({ name: '0 tests', regex: /#\s*tests\s+0\b|\b0\s+tests?\b/ }),
]);

/**
 * Scan combined stdout+stderr line-by-line for a RED-load-failure signature.
 *
 * Lines ignored:
 *   - stack frames matching /^\s+at\s/ — a `ReferenceError:` thrown inside
 *     a passing test's `assert.throws` reports the type name on a stack
 *     frame; we don't want that to count as a top-level load failure.
 *   - lines inside a contiguous `details:` block — node:test prints the
 *     expected/actual values of a failing `assert.throws` under a
 *     `details:` heading; the block ends when indentation returns to the
 *     heading column or earlier, on the YAML doc-end `...`, or on a blank
 *     line.
 *
 * Fail-closed: if the scan throws unexpectedly, return a match with
 * signature `'scan-error'` so the recorder rejects rather than silently
 * accepting the RED.
 *
 * @param {string} output combined stdout + '\n' + stderr
 * @returns {{ matched: boolean, signature: string|null }}
 */
function detectRedLoadFailure(output) {
  try {
    if (typeof output !== 'string' || output.length === 0) {
      return { matched: false, signature: null };
    }
    const lines = output.split(/\r?\n/);
    let inDetailsBlock = false;
    let detailsBaseIndent = -1;
    for (const line of lines) {
      if (/^\s+at\s/.test(line)) continue;
      const trimmed = line.trim();
      if (inDetailsBlock) {
        const indentMatch = line.match(/^(\s*)\S/);
        const indent = indentMatch ? indentMatch[1].length : -1;
        if (trimmed === '' || trimmed === '...' || indent <= detailsBaseIndent) {
          inDetailsBlock = false;
          detailsBaseIndent = -1;
        } else {
          continue;
        }
      }
      if (/^\s*details:\s*$/.test(line)) {
        inDetailsBlock = true;
        const headIndent = line.match(/^(\s*)/)[1].length;
        detailsBaseIndent = headIndent;
        continue;
      }
      for (const pattern of RED_LOAD_FAILURE_PATTERNS) {
        if (pattern.regex.test(line)) {
          return { matched: true, signature: pattern.name };
        }
      }
    }
    return { matched: false, signature: null };
  } catch {
    return { matched: true, signature: 'scan-error' };
  }
}

/**
 * Extract a short (~200 char) snippet of the matched line(s) from the
 * combined runner output for audit-row `meta.snippet`.
 *
 * @param {string} output combined stdout+stderr
 * @param {string} signatureName one of RED_LOAD_FAILURE_PATTERNS[].name
 * @returns {string}
 */
function extractLoadFailureSnippet(output, signatureName) {
  const MAX = 200;
  try {
    if (typeof output !== 'string' || output.length === 0) return '';
    const pattern = RED_LOAD_FAILURE_PATTERNS.find((p) => p.name === signatureName);
    if (!pattern) return output.slice(0, MAX);
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      if (/^\s+at\s/.test(line)) continue;
      if (pattern.regex.test(line)) {
        return line.trim().slice(0, MAX);
      }
    }
    return output.slice(0, MAX);
  } catch {
    return '';
  }
}

module.exports = {
  RED_LOAD_FAILURE_PATTERNS,
  detectRedLoadFailure,
  extractLoadFailureSnippet,
};
