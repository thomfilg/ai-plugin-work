/**
 * tests-baseline.js — net-new vs pre-existing failure split for the /check2
 * test runner (GH-394, echo-5137-4 partial).
 *
 * Answers "did MY changes regress tests?" instead of "is the whole repo
 * green?". Running the suite at origin/<BASE> is too expensive inline, so we
 * keep a cached baseline file (`tests-baseline.json`) at the repo root:
 *
 *   - written after every classified run of 4_run_tests (green runs record
 *     failures: []; red runs are NOT recorded — a red baseline could only
 *     come from a verified base-branch run, which we don't do inline)
 *   - read on failure to split failing tests into net-new vs pre-existing
 *
 * When no baseline is obtainable, callers must say "baseline unavailable"
 * and behave exactly as today (all failures block).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BASELINE_FILE = 'tests-baseline.json';

function baselinePath(dir) {
  return path.join(dir || process.cwd(), BASELINE_FILE);
}

/**
 * Read the cached baseline. Returns null when missing/unparseable/disabled
 * (CHECK_TESTS_BASELINE=0).
 * @param {string} [dir] repo root (default cwd)
 * @returns {{ref: string|null, recordedAt: string, failures: string[]}|null}
 */
function readBaseline(dir) {
  if (process.env.CHECK_TESTS_BASELINE === '0') return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(baselinePath(dir), 'utf8'));
    if (!parsed || !Array.isArray(parsed.failures)) return null;
    return {
      ref: typeof parsed.ref === 'string' ? parsed.ref : null,
      recordedAt: typeof parsed.recordedAt === 'string' ? parsed.recordedAt : 'unknown',
      failures: parsed.failures.filter((f) => typeof f === 'string' && f.trim() !== ''),
    };
  } catch {
    return null;
  }
}

/**
 * Record a green baseline (failures: []) at the current HEAD. Only called
 * after a PASSED/FLAKY run — a passing run proves every test green at this
 * commit, which is the cheapest trustworthy baseline available.
 * Best-effort: failures to write never break the step.
 * @param {string} [dir] repo root (default cwd)
 * @param {string[]} [failures] known failures (default [])
 */
function writeBaseline(dir, failures = []) {
  if (process.env.CHECK_TESTS_BASELINE === '0') return;
  let ref = null;
  try {
    ref = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    /* not a git repo — ref stays null */
  }
  try {
    fs.writeFileSync(
      baselinePath(dir),
      JSON.stringify({ ref, recordedAt: new Date().toISOString(), failures }, null, 2) + '\n'
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Split current failing tests into net-new vs pre-existing using the
 * baseline's recorded failures. Matching is by exact identifier first, then
 * by loose containment either way (runner output formats drift between runs:
 * "file > suite > name" vs "name").
 * @param {string[]} failingTests
 * @param {{failures: string[]}|null} baseline
 * @returns {{netNew: string[], preExisting: string[]}}
 */
function splitFailures(failingTests, baseline) {
  if (!baseline) return { netNew: failingTests.slice(), preExisting: [] };
  const base = baseline.failures;
  const netNew = [];
  const preExisting = [];
  for (const t of failingTests) {
    const known = base.some((b) => b === t || b.includes(t) || t.includes(b));
    (known ? preExisting : netNew).push(t);
  }
  return { netNew, preExisting };
}

module.exports = { BASELINE_FILE, baselinePath, readBaseline, writeBaseline, splitFailures };
