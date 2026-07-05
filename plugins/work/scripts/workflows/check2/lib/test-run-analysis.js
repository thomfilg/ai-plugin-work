/**
 * test-run-analysis.js — shared crash/flake/count parsing for the /check2 test
 * runner steps (GH-394: echo-4491-003, echo-4492-001, echo-5137-4).
 *
 * The raw `exitCode !== 0` heuristic conflates three very different outcomes:
 *   - FAILED:  real assertion failures (tests ran, some failed)
 *   - CRASHED: the runner itself died (OOM, worker crash, signal) — an infra
 *     problem, NOT a test failure. Classic symptom: "Tests 8250 passed |
 *     0 failed" but exit code 1 because a worker fork OOM'd.
 *   - FLAKY:   failed once, passed on a single retry (transient timeouts,
 *     port contention, resource starvation under full-suite load).
 *
 * classifyRun() implements the "M === 0" guard from echo-4491-003: a nonzero
 * exit with zero parsed test failures (or zero tests executed) is CRASHED,
 * never "all tests failed" and never a silent pass.
 */

'use strict';

// ---------------------------------------------------------------------------
// Crash signatures — runner-level death, not assertion failures.
// Each pattern is matched against the combined stdout+stderr; the matching
// LINE is quoted in the report so the operator sees the exact evidence.
// ---------------------------------------------------------------------------
const CRASH_PATTERNS = [
  /JavaScript heap out of memory/i,
  /FATAL ERROR/,
  /Worker exited unexpectedly/i,
  /worker (?:process )?(?:crashed|terminated)/i,
  /Test run terminated/i,
  /\bSIGKILL\b/,
  /\bSIGSEGV\b/,
  /\bSIGABRT\b/,
  /\bSIGBUS\b/,
  /terminated by signal/i,
  /Killed(?::| \(signal\)|\s*$)/m,
  /Segmentation fault/i,
  /Allocation failed - process out of memory/i,
];

// ---------------------------------------------------------------------------
// Transient signatures — failures worth one retry round (echo-4492-001).
// ---------------------------------------------------------------------------
const TRANSIENT_PATTERNS = [
  /Test timed out in \d+m?s/i,
  /timed? ?out (?:after|in|waiting)/i,
  /\bETIMEDOUT\b/,
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bEADDRINUSE\b/,
  /port (?:\d+ )?(?:is )?(?:already )?in use/i,
  /address already in use/i,
  /socket hang ?up/i,
];

/**
 * Return the exact LINE containing the first match of any pattern, or null.
 * The matching line is quotable evidence for reports.
 * @param {string} output combined stdout+stderr
 * @param {RegExp[]} patterns
 * @returns {string|null}
 */
function findSignatureLine(output, patterns) {
  if (!output) return null;
  for (const re of patterns) {
    const m = output.match(re);
    if (m) {
      const start = output.lastIndexOf('\n', m.index) + 1;
      const endIdx = output.indexOf('\n', m.index);
      const end = endIdx === -1 ? output.length : endIdx;
      return output.slice(start, end).trim();
    }
  }
  return null;
}

/**
 * Return the exact line containing the first crash signature, or null.
 * @param {string} output combined stdout+stderr
 * @returns {string|null} the trimmed matching line (quotable evidence)
 */
function detectCrashSignature(output) {
  return findSignatureLine(output, CRASH_PATTERNS);
}

/**
 * Return the exact line containing the first transient-failure signature
 * (timeout / connection refused / port in use), or null.
 * @param {string} output
 * @returns {string|null}
 */
function detectTransientSignature(output) {
  return findSignatureLine(output, TRANSIENT_PATTERNS);
}

/**
 * Parse pass/fail/total counts from runner output. Understands:
 *   - vitest/jest summary:  "Tests  1 failed | 3485 passed | 2 skipped (3488)"
 *                           "Tests 8250 passed | 3 skipped"
 *   - node --test TAP:      "# pass 12" / "# fail 0" / "# tests 12"
 *   - generic:              "pass 12" / "fail 3"
 * Returns numbers or null per field when unparseable.
 * @param {string} output
 * @returns {{passed: number|null, failed: number|null, total: number|null}}
 */
// vitest/jest style: "<N> <word>" (number BEFORE the word). Prefer the LAST
// occurrence (the final summary line, not per-file lines). Null when absent.
function lastSummaryCount(output, re) {
  const all = [...output.matchAll(re)];
  return all.length ? parseInt(all[all.length - 1][1], 10) : null;
}

// node --test / TAP style: "pass 12" / "# fail 0" / "ℹ tests 12" (word BEFORE
// the number). Null when absent.
function tapCount(output, word) {
  const m = output.match(new RegExp(`(?:^|\\n)\\s*(?:#\\s*|ℹ\\s*)?${word}\\s+(\\d+)`, 'i'));
  return m ? parseInt(m[1], 10) : null;
}

// Totals: "(3488)" after a Tests summary, "# tests 12", or passed+failed.
function parseTotal(output, counts) {
  const vitestTotal = output.match(/Tests[^\n]*\((\d+)\)/i);
  if (vitestTotal) return parseInt(vitestTotal[1], 10);
  const tapTotal = tapCount(output, 'tests');
  if (tapTotal !== null) return tapTotal;
  if (counts.passed !== null || counts.failed !== null) {
    return (counts.passed || 0) + (counts.failed || 0);
  }
  return null;
}

function parseTestCounts(output) {
  const counts = { passed: null, failed: null, total: null };
  if (!output) return counts;

  counts.passed = lastSummaryCount(output, /(\d+)\s+passed\b/gi);
  counts.failed = lastSummaryCount(output, /(\d+)\s+failed\b/gi);

  if (counts.passed === null) counts.passed = tapCount(output, 'pass(?:ed)?');
  if (counts.failed === null) counts.failed = tapCount(output, 'fail(?:ed)?');

  counts.total = parseTotal(output, counts);
  return counts;
}

/**
 * Best-effort extraction of failing test identifiers (file paths and/or test
 * names) from runner output. Understands:
 *   - vitest/jest:   "FAIL  path/to/file.test.ts > suite > name"
 *                    " ✗ name" / " × name"
 *   - node --test:   "not ok 3 - name"  /  "✖ name"
 * Deduplicated, order preserved. Empty array when nothing recognizable.
 * @param {string} output
 * @returns {string[]}
 */
function extractFailingTests(output) {
  if (!output) return [];
  const found = [];
  const seen = new Set();
  const push = (name) => {
    const n = name.trim().replace(/\s*\(\d+(?:\.\d+)?m?s\)\s*$/, '');
    if (n && !seen.has(n)) {
      seen.add(n);
      found.push(n);
    }
  };

  for (const line of output.split('\n')) {
    let m;
    if ((m = line.match(/^\s*(?:❯\s*)?FAIL\s+(\S.*)$/))) {
      // "FAIL  src/foo.test.ts > suite > case" or "FAIL src/foo.test.ts"
      push(m[1]);
    } else if ((m = line.match(/^\s*not ok\s+\d+\s*-\s*(.+)$/))) {
      push(m[1]);
    } else if ((m = line.match(/^\s*[✗✖×]\s+(.+)$/))) {
      push(m[1]);
    }
  }
  return found;
}

/**
 * Classify a completed test run (echo-4491-003).
 *
 * Rules:
 *   - exit 0                          → PASSED
 *   - nonzero + crash signature       → CRASHED (quote the signature)
 *   - nonzero + parsed failures === 0 → CRASHED ("M === 0" guard: the runner
 *     died or reported nothing; NEVER "all tests failed", NEVER a pass)
 *   - nonzero + 0 tests executed      → CRASHED (same guard)
 *   - nonzero + failures > 0          → FAILED
 *   - nonzero + unparseable output    → FAILED (today's conservative behavior)
 *
 * @param {{output: string, exitCode: number}} result
 * @returns {{
 *   result: 'PASSED'|'FAILED'|'CRASHED',
 *   crashSignature: string|null,
 *   transientSignature: string|null,
 *   counts: {passed: number|null, failed: number|null, total: number|null},
 *   failingTests: string[],
 * }}
 */
function classifyRun(result) {
  const output = result.output || '';
  const counts = parseTestCounts(output);
  const crashSignature = detectCrashSignature(output);
  const transientSignature = detectTransientSignature(output);
  const failingTests = extractFailingTests(output);

  if (result.exitCode === 0) {
    return {
      result: 'PASSED',
      crashSignature: null,
      transientSignature: null,
      counts,
      failingTests: [],
    };
  }

  // Crash signature always wins: the runner died, tests didn't "fail".
  if (crashSignature) {
    return { result: 'CRASHED', crashSignature, transientSignature, counts, failingTests };
  }

  // "M === 0" guard: nonzero exit, but the parsed summary shows zero failures
  // (e.g. "Tests 8250 passed | 3 skipped", exit 1 → worker OOM'd after the
  // summary) OR zero tests executed at all. Infra problem — CRASHED.
  const guardSignature = zeroGuardSignature(result.exitCode, counts, failingTests);
  if (guardSignature) {
    return {
      result: 'CRASHED',
      crashSignature: guardSignature,
      transientSignature,
      counts,
      failingTests,
    };
  }

  return { result: 'FAILED', crashSignature: null, transientSignature, counts, failingTests };
}

// The "M === 0" guard evidence line, or null when the run really failed.
function zeroGuardSignature(exitCode, counts, failingTests) {
  const zeroFailures = counts.failed === 0 && failingTests.length === 0;
  const zeroExecuted = counts.total === 0 || (counts.passed === 0 && counts.failed === 0);
  if ((counts.failed !== null && zeroFailures) || (counts.total !== null && zeroExecuted)) {
    return `nonzero exit (${exitCode}) with ${counts.total === 0 ? '0 tests executed' : '0 test failures'} — runner-level failure`;
  }
  return null;
}

/**
 * Decide whether a FAILED run qualifies for the single flake-retry round
 * (echo-4492-001): the failing set is small (≤ maxFailing, default 5 via
 * CHECK_FLAKE_RETRY_MAX) OR the output carries a transient signature.
 * CRASHED runs never qualify. CHECK_FLAKE_RETRY=0 disables retries.
 *
 * @param {ReturnType<typeof classifyRun>} analysis
 * @param {{maxFailing?: number, enabled?: boolean}} [opts]
 * @returns {{retry: boolean, reason: string|null}}
 */
// Smallest available failing-set size when it is within the retry budget:
// itemized failing tests first, parsed failed count as fallback. Null when
// the set is empty or over budget.
function smallFailingSetSize(analysis, maxFailing) {
  const n = analysis.failingTests.length;
  if (n > 0 && n <= maxFailing) return n;
  const failed = analysis.counts.failed;
  if (failed !== null && failed > 0 && failed <= maxFailing) return failed;
  return null;
}

function shouldRetry(analysis, opts = {}) {
  const enabled = opts.enabled ?? process.env.CHECK_FLAKE_RETRY !== '0';
  if (!enabled || analysis.result !== 'FAILED') return { retry: false, reason: null };

  const maxFailing = opts.maxFailing ?? (parseInt(process.env.CHECK_FLAKE_RETRY_MAX, 10) || 5);

  if (analysis.transientSignature) {
    return { retry: true, reason: `transient signature: "${analysis.transientSignature}"` };
  }
  const small = smallFailingSetSize(analysis, maxFailing);
  if (small !== null) {
    return { retry: true, reason: `small failing set (${small} ≤ ${maxFailing})` };
  }
  return { retry: false, reason: null };
}

module.exports = {
  CRASH_PATTERNS,
  TRANSIENT_PATTERNS,
  detectCrashSignature,
  detectTransientSignature,
  parseTestCounts,
  extractFailingTests,
  classifyRun,
  shouldRetry,
};
