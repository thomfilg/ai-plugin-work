/**
 * Phase: test_pass_crossref.
 *
 * GH-282 Task 6. For each DELIVERED row in the `## Requirement Coverage` table
 * whose Evidence cites a test file + test name (e.g. `foo.test.js:test_R4`),
 * verify that `tests.check.md` reports the test as PASS/COMPLETE/APPROVED.
 *
 * - DELIVERED row cites a test that PASSed   ⇒ ok:true
 * - DELIVERED row cites a test that FAILed   ⇒ failure record (checkType=test_pass)
 * - tests.check.md absent (with any cited test) ⇒ failure record (no silent skip)
 * - No DELIVERED row cites a test in Evidence ⇒ ok:true (backward compat skip)
 *
 * Fail-closed wrap: any thrown parser/IO error becomes
 * `{ ok: false, errors: [...] }`.
 */

'use strict';

const { COMPLETION_PHASES } = require('../../completion-phase-registry');
const { readRequirementCoverage, readTestReport } = require('../kind-checks/shared');
const { makeFailure } = require('../failure-record');
const { appendForCheckType } = require('../failure-store');
const {
  hasVerdict,
  escapeRegex,
  buildVerdictRegex,
} = require('../../../lib/parse-completion-status');

// B4/B5 fix: tighten the test-file char class so a leading `(` is not captured
// (`\S+` would grab `(foo.test.js`), and allow `-` and `.` in test names so
// kebab-case (`should-handle-x`) and dotted (`case.1`) descriptors match.
const CITATION_RE = /([\w./@-]+\.test\.[jt]sx?):([\w.-]+)/;
const CITATION_RE_G = /([\w./@-]+\.test\.[jt]sx?):([\w.-]+)/g;
const PASS_VERDICTS = ['PASS', 'COMPLETE', 'APPROVED'];
const FAIL_VERDICTS = ['FAIL', 'BLOCKED', 'NOT_DELIVERED', 'NEEDS_WORK'];

/**
 * Extract the first `{ testFile, testName }` citation from an Evidence cell,
 * or null if the cell does not reference a test file. Kept for backward
 * compatibility with existing tests; new code should use
 * `parseEvidenceCitations` to capture every citation in the cell.
 *
 * @param {string} cell
 * @returns {{ testFile: string, testName: string } | null}
 */
function parseEvidenceCitation(cell) {
  if (typeof cell !== 'string' || !cell) return null;
  const m = CITATION_RE.exec(cell);
  if (!m) return null;
  return { testFile: m[1], testName: m[2] };
}

/**
 * Extract every `{ testFile, testName }` citation from an Evidence cell.
 * An Evidence cell may list more than one test (e.g.
 * `foo.test.js:t1, bar.test.js:t2`); each citation must be verified
 * independently against `tests.check.md`.
 *
 * @param {string} cell
 * @returns {Array<{ testFile: string, testName: string }>}
 */
function parseEvidenceCitations(cell) {
  if (typeof cell !== 'string' || !cell) return [];
  const out = [];
  for (const m of cell.matchAll(CITATION_RE_G)) {
    out.push({ testFile: m[1], testName: m[2] });
  }
  return out;
}

/**
 * Find the line in `reportContent` that carries the verdict for `testName`.
 * Prefers a line that BOTH mentions the test name AND has a `Status:` /
 * `Verdict:` marker; falls back to the first mention only if no such line
 * exists. This avoids spurious failures when the test name appears in a
 * heading or summary line above the actual `Status: PASS` line.
 *
 * @param {string} reportContent
 * @param {string} testName
 * @returns {string | null}
 */
function findTestLine(reportContent, testName) {
  if (!reportContent) return null;
  const re = new RegExp(`\\b${escapeRegex(testName)}\\b`);
  const ALL_VERDICTS = ['PASS', 'FAIL', 'COMPLETE', 'APPROVED', 'BLOCKED', 'NOT_DELIVERED'];
  let firstMention = null;
  for (const line of reportContent.split('\n')) {
    if (!re.test(line)) continue;
    if (firstMention === null) firstMention = line;
    if (hasVerdict(line, ALL_VERDICTS)) return line;
  }
  return firstMention;
}

/**
 * Decide whether `reportContent` (whole tests.check.md) carries a top-level
 * passing verdict.
 *
 * Why this exists: the canonical writer (`write-tests-report.js`) emits a
 * single `Status: APPROVED` or `Status: NEEDS_WORK` header at the top of the
 * file. Per-test rows are formatted as `- Status: ✅ PASS` lines *without*
 * a `Status:` prefix per row in many real outputs (markdown tables, plain
 * suite summaries). The per-line `hasVerdict` matcher would miss the row and
 * spuriously block completion. The correct signal is the file-level verdict;
 * per-test verification then only needs to confirm the test name *appears*
 * in the report (proving it was executed).
 *
 * Returns one of: 'PASS' | 'FAIL' | 'UNKNOWN'.
 */
function classifyOverallVerdict(reportContent) {
  if (!reportContent) return 'UNKNOWN';
  if (hasVerdict(reportContent, FAIL_VERDICTS)) return 'FAIL';
  if (hasVerdict(reportContent, PASS_VERDICTS)) return 'PASS';
  return 'UNKNOWN';
}

function collectDeliveredCitations(coverage) {
  const out = [];
  for (const row of coverage) {
    if (!row || String(row.status).toUpperCase() !== 'DELIVERED') continue;
    const cites = parseEvidenceCitations(row.evidence);
    for (const cite of cites) {
      out.push({ row, cite });
    }
  }
  return out;
}

function recordMissingReport(deliveredCitations, failures) {
  // One failure per requirement row, not per citation — multiple citations
  // on the same row share the same root cause (tests.check.md missing).
  const seen = new Set();
  for (const { row } of deliveredCitations) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    failures.push(
      makeFailure({
        requirementId: row.id,
        checkType: 'test_pass',
        expected: 'tests.check.md present',
        observed: 'tests.check.md not found — cannot verify test pass',
      })
    );
  }
}

const VERDICT_WORDS = ['PASS', 'FAIL', 'COMPLETE', 'APPROVED', 'BLOCKED', 'NOT_DELIVERED'];

/**
 * Extract the verdict word from a line using the SAME prefix-bound matcher
 * (`buildVerdictRegex`) that `hasVerdict` uses, so the extracted word always
 * corresponds to a verdict that `hasVerdict` would also recognize. Returns
 * null when the line has no recognized verdict (e.g. bare `test_R4 — PASS`
 * without a `Status:` / `Verdict:` label).
 */
function extractVerdictWord(line) {
  if (!line) return null;
  const m = buildVerdictRegex(VERDICT_WORDS).exec(line);
  return m ? m[1].toUpperCase() : null;
}

// Review feedback (round 2): bare-fail detection must NOT case-insensitively
// match English words like "fail" / "failure" in descriptive prose, or a
// passing test row whose description contains those words gets wrongly
// marked failing under an overall-PASS verdict. Only treat as fail when the
// keyword appears in the form a test runner / report writer actually uses:
//   - ALL-CAPS keyword (FAIL, FAILED, BLOCKED, NOT_DELIVERED, NEEDS_WORK)
//   - A common runner failure marker (✗, ✘, ❌)
// Lowercase prose mentions ("does not fail") no longer trip the gate.
const BARE_FAIL_RE =
  /(?:\b(?:FAIL(?:ED|URE)?|BLOCKED|NOT[_\s-]?DELIVERED|NEEDS[_\s-]?WORK)\b|[✗✘❌])/;

function lineHasBareFail(line) {
  return Boolean(line) && BARE_FAIL_RE.test(line);
}

function evaluateCitation(reportContent, overall, cite) {
  const nameRe = new RegExp(`\\b${escapeRegex(cite.testName)}\\b`);
  const named = nameRe.test(reportContent);
  const line = findTestLine(reportContent, cite.testName);
  const lineSaysPass = line !== null && hasVerdict(line, PASS_VERDICTS);
  const lineSaysFail = line !== null && (hasVerdict(line, FAIL_VERDICTS) || lineHasBareFail(line));
  if (lineSaysPass) return { passed: true };
  if (overall === 'PASS' && named && !lineSaysFail) return { passed: true };
  return { passed: false, named, line, lineSaysFail };
}

function describeCitationFailure(cite, overall, evalResult) {
  if (!evalResult.named) {
    return `${cite.testName} not found in tests.check.md — not executed or not recorded`;
  }
  if (evalResult.lineSaysFail) {
    const v = extractVerdictWord(evalResult.line) || 'FAIL';
    return `${cite.testName} ${v} in tests.check.md`;
  }
  if (overall === 'FAIL') {
    return `${cite.testName} present in tests.check.md but report verdict is NEEDS_WORK/FAIL`;
  }
  return `${cite.testName} mentioned in tests.check.md but no PASS verdict found (file-level verdict ${overall})`;
}

function checkCitations(deliveredCitations, reportContent, failures) {
  // B1 fix: evaluate against the file-level verdict produced by the canonical
  // tests-report writer, not per-line markers. Per-test rows in tests.check.md
  // typically lack a `Status:` prefix, so the previous per-line `hasVerdict`
  // call false-flagged passing tests.
  const overall = classifyOverallVerdict(reportContent);
  let testsChecked = 0;
  let testsFailing = 0;
  for (const { row, cite } of deliveredCitations) {
    testsChecked += 1;
    const result = evaluateCitation(reportContent, overall, cite);
    if (result.passed) continue;
    testsFailing += 1;
    failures.push(
      makeFailure({
        requirementId: row.id,
        checkType: 'test_pass',
        expected: `${cite.testName} PASS`,
        observed: describeCitationFailure(cite, overall, result),
      })
    );
  }
  return { testsChecked, testsFailing };
}

/**
 * B2 fix: when the top-level `## Requirement Coverage` table has DELIVERED
 * rows but ZERO of them cite a test in their Evidence cell, the previous
 * implementation silently skipped test verification — which is the exact
 * failure mode ticket #282 calls out ("checked 'does code exist' but never
 * verified tests pass"). Surface a single advisory failure so the gate has
 * teeth without exploding noise per row (kind_checks already covers the
 * per-row behavioral classification).
 *
 * Review feedback: legacy tickets that only use the R4 fallback (per-task
 * `### Requirements Covered` bullets) synthesize rows whose evidence is
 * always `tasks.md:Task N` and could never carry test citations by design.
 * Filter those out so B2 only fires against table-sourced rows.
 */
function recordZeroCitationsFailure(coverage, failures) {
  const delivered = coverage.filter(
    (r) => r && String(r.status).toUpperCase() === 'DELIVERED' && r.source !== 'subsection'
  );
  if (delivered.length === 0) return false;
  failures.push(
    makeFailure({
      requirementId: delivered[0].id || 'R?',
      checkType: 'test_pass',
      expected: 'at least one DELIVERED row cites a test (foo.test.js:test_name)',
      observed: `${delivered.length} DELIVERED row(s), 0 cite a test — cannot verify pass`,
    })
  );
  return true;
}

// Synchronous — see note in reuse_audit_enforcement.js.
function validate(ctx) {
  const failures = ctx.failures || (ctx.failures = []);
  const startLen = failures.length;
  try {
    const coverage = readRequirementCoverage(ctx.tasksDir) || [];
    const deliveredCitations = collectDeliveredCitations(coverage);

    if (deliveredCitations.length === 0) {
      // B2: if there are DELIVERED rows but none cite a test, fail closed
      // instead of silently skipping. An empty coverage table (no DELIVERED
      // rows at all) still skips — coverage_check is responsible for that.
      const hadFailure = recordZeroCitationsFailure(coverage, failures);
      ctx.testsChecked = 0;
      appendForCheckType(ctx.tasksDir, 'test_pass', failures.slice(startLen), { testsChecked: 0 });
      if (hadFailure) {
        return {
          ok: false,
          errors: ['DELIVERED rows have no test citations'],
          summary: 'test_pass_crossref: 0 citations across DELIVERED rows',
        };
      }
      return { ok: true, summary: 'no DELIVERED rows to verify — skipped' };
    }

    const report = readTestReport(ctx.tasksDir);
    if (!report.exists) {
      recordMissingReport(deliveredCitations, failures);
      ctx.testsChecked = 0;
      appendForCheckType(ctx.tasksDir, 'test_pass', failures.slice(startLen), { testsChecked: 0 });
      return {
        ok: false,
        errors: ['tests.check.md missing'],
        summary: `test_pass_crossref: ${deliveredCitations.length} citation(s), tests.check.md missing`,
      };
    }

    const { testsChecked, testsFailing } = checkCitations(
      deliveredCitations,
      report.content,
      failures
    );
    ctx.testsChecked = testsChecked;
    appendForCheckType(ctx.tasksDir, 'test_pass', failures.slice(startLen), { testsChecked });

    if (testsFailing > 0) {
      return {
        ok: false,
        errors: [`${testsFailing} cited test(s) did not PASS`],
        summary: `test_pass_crossref: ${testsChecked} checked, ${testsFailing} failing`,
      };
    }
    return {
      ok: true,
      summary: `test_pass_crossref: ${testsChecked} checked, 0 failing`,
    };
  } catch (err) {
    return {
      ok: false,
      errors: [`parser threw: ${err && err.message ? err.message : String(err)}`],
      summary: 'test_pass_crossref phase error (fail-closed)',
    };
  }
}

function instructions() {
  return '';
}

module.exports = function register(registerPhase) {
  registerPhase(COMPLETION_PHASES.test_pass_crossref, {
    next: COMPLETION_PHASES.kind_checks,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
module.exports.parseEvidenceCitation = parseEvidenceCitation;
module.exports.parseEvidenceCitations = parseEvidenceCitations;
module.exports.classifyOverallVerdict = classifyOverallVerdict;
