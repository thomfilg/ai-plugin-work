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
const { hasVerdict, escapeRegex } = require('../../../lib/parse-completion-status');

const CITATION_RE = /(\S+\.test\.[jt]sx?):(\w+)/;
const PASS_VERDICTS = ['PASS', 'COMPLETE', 'APPROVED'];

/**
 * Extract a `{ testFile, testName }` citation from an Evidence cell, or null
 * if the cell does not reference a test file.
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
 * Find the first line in `reportContent` that mentions `testName`.
 *
 * @param {string} reportContent
 * @param {string} testName
 * @returns {string | null}
 */
function findTestLine(reportContent, testName) {
  if (!reportContent) return null;
  const re = new RegExp(`\\b${escapeRegex(testName)}\\b`);
  for (const line of reportContent.split('\n')) {
    if (re.test(line)) return line;
  }
  return null;
}

function collectDeliveredCitations(coverage) {
  const out = [];
  for (const row of coverage) {
    if (!row || String(row.status).toUpperCase() !== 'DELIVERED') continue;
    const cite = parseEvidenceCitation(row.evidence);
    if (!cite) continue;
    out.push({ row, cite });
  }
  return out;
}

function recordMissingReport(deliveredCitations, failures) {
  for (const { row } of deliveredCitations) {
    failures.push(
      makeFailure({
        requirementId: row.id,
        checkType: 'test_pass',
        expected: 'tests.check.md present',
        observed: 'tests.check.md not found — cannot verify test pass',
      }),
    );
  }
}

function checkCitations(deliveredCitations, reportContent, failures) {
  let testsChecked = 0;
  let testsFailing = 0;
  for (const { row, cite } of deliveredCitations) {
    testsChecked += 1;
    const line = findTestLine(reportContent, cite.testName);
    if (line !== null && hasVerdict(line, PASS_VERDICTS)) continue;
    testsFailing += 1;
    const observed =
      line === null
        ? `${cite.testName} not found in tests.check.md — not executed or not recorded`
        : `${cite.testName} FAIL in tests.check.md`;
    failures.push(
      makeFailure({
        requirementId: row.id,
        checkType: 'test_pass',
        expected: `${cite.testName} PASS`,
        observed,
      }),
    );
  }
  return { testsChecked, testsFailing };
}

async function validate(ctx) {
  const failures = ctx.failures || (ctx.failures = []);
  try {
    const coverage = readRequirementCoverage(ctx.tasksDir) || [];
    const deliveredCitations = collectDeliveredCitations(coverage);

    if (deliveredCitations.length === 0) {
      ctx.testsChecked = 0;
      return { ok: true, summary: 'no DELIVERED row cites a test — skipped' };
    }

    const report = readTestReport(ctx.tasksDir);
    if (!report.exists) {
      recordMissingReport(deliveredCitations, failures);
      ctx.testsChecked = 0;
      return {
        ok: false,
        errors: ['tests.check.md missing'],
        summary: `test_pass_crossref: ${deliveredCitations.length} citation(s), tests.check.md missing`,
      };
    }

    const { testsChecked, testsFailing } = checkCitations(
      deliveredCitations,
      report.content,
      failures,
    );
    ctx.testsChecked = testsChecked;

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
