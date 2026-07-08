const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'check-validate-reports.js');
const { validateQAReport } = require(SCRIPT);
// Private per-run temp root (mkdtemp → mode 0700, unpredictable name) — never
// write directly into the shared os.tmpdir() (insecure-temporary-file).
let TEMP;

/**
 * Build a minimal QA report with the given status token.
 * Includes all required sections so only the status line varies.
 */
function buildQAReport(statusToken, opts = {}) {
  const lines = [
    '**Changes Hash:** abc123',
    '',
    `Status: ${statusToken}`,
    '',
    '## Playwright Verification',
    '',
    '![screenshot](./screenshots/test.png)',
    '',
  ];
  if (opts.infraFailure) {
    lines.push('INFRASTRUCTURE_FAILURE');
  }
  if (opts.accessFailed) {
    lines.push('ACCESS_FAILED');
  }
  return lines.join('\n');
}

/**
 * Build a QA report that has NO Playwright section and NO screenshots
 * (the shape produced when the check plan skipped 3_verify_playwright).
 */
function buildQAReportNoPlaywright(statusToken, opts = {}) {
  const lines = [];
  if (!opts.omitChangesHash) {
    lines.push('**Changes Hash:** abc123', '');
  }
  lines.push(`Status: ${statusToken}`, '');
  return lines.join('\n');
}

/**
 * Run the validate-reports script and return parsed JSON + exit code.
 * Optional 3rd CLI arg is the PLAYWRIGHT_SKIPPED_JSON signal (passed verbatim).
 */
function runScript(reportFolder, impactedApps, playwrightSkippedArg) {
  const args = [SCRIPT, reportFolder, JSON.stringify(impactedApps)];
  if (playwrightSkippedArg !== undefined) args.push(playwrightSkippedArg);
  try {
    const stdout = execFileSync('node', args, {
      encoding: 'utf-8',
      timeout: 10000,
    });
    return { exitCode: 0, result: JSON.parse(stdout) };
  } catch (err) {
    const stdout = (err.stdout || '').toString();
    let result = null;
    try {
      result = JSON.parse(stdout);
    } catch (_) {
      /* script may not output valid JSON on some failures */
    }
    return { exitCode: err.status, result };
  }
}

function setupDir(name) {
  const dir = path.join(TEMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

before(() => {
  TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'check-validate-reports-test-'));
});

after(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
});

describe('check-validate-reports.js — validateQAReport canonical status matching', () => {
  // --- Backward compat: legacy statuses still work ---

  it('accepts a QA report with legacy PASS status', () => {
    const dir = setupDir('legacy-pass');
    // Write required non-QA reports so the script doesn't fail on missing files
    fs.writeFileSync(path.join(dir, 'tests.check.md'), '**Changes Hash:** x\n✅ PASS');
    fs.writeFileSync(path.join(dir, 'code-review.check.md'), '**Changes Hash:** x\nNo issues');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), '**Changes Hash:** x\nCOMPLETE');
    fs.writeFileSync(path.join(dir, 'README.md'), 'readme');
    fs.writeFileSync(path.join(dir, 'qa-myapp.check.md'), buildQAReport('PASS'));

    const { result } = runScript(dir, ['myapp']);
    assert.ok(result.reports.qa.myapp.exists, 'report should exist');
    assert.ok(!result.reports.qa.myapp.failed, 'PASS should not be marked failed');
    // hasStatus must have detected PASS
    assert.deepEqual(
      result.reports.qa.myapp.issues.filter((i) => i.includes('Missing PASS/FAIL')),
      []
    );
  });

  it('detects a QA report with legacy FAIL status as failed', () => {
    const dir = setupDir('legacy-fail');
    fs.writeFileSync(path.join(dir, 'tests.check.md'), '**Changes Hash:** x\n✅ PASS');
    fs.writeFileSync(path.join(dir, 'code-review.check.md'), '**Changes Hash:** x\nNo issues');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), '**Changes Hash:** x\nCOMPLETE');
    fs.writeFileSync(path.join(dir, 'README.md'), 'readme');
    fs.writeFileSync(
      path.join(dir, 'qa-myapp.check.md'),
      buildQAReport('FAIL').replace('Status: FAIL', '❌ FAIL\nStatus: FAIL')
    );

    const { result } = runScript(dir, ['myapp']);
    assert.ok(result.reports.qa.myapp.failed, 'FAIL should be detected as failed');
  });

  // --- Canonical statuses: APPROVED / NEEDS_WORK ---

  it('accepts a QA report with canonical APPROVED status (no missing-status issue)', () => {
    const dir = setupDir('canonical-approved');
    fs.writeFileSync(path.join(dir, 'tests.check.md'), '**Changes Hash:** x\n✅ PASS');
    fs.writeFileSync(path.join(dir, 'code-review.check.md'), '**Changes Hash:** x\nNo issues');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), '**Changes Hash:** x\nCOMPLETE');
    fs.writeFileSync(path.join(dir, 'README.md'), 'readme');
    fs.writeFileSync(path.join(dir, 'qa-myapp.check.md'), buildQAReport('APPROVED'));

    const { result } = runScript(dir, ['myapp']);
    assert.ok(result.reports.qa.myapp.exists, 'report should exist');
    // The key assertion: APPROVED must be recognized as a valid status
    const statusIssues = result.reports.qa.myapp.issues.filter((i) => i.includes('Missing'));
    assert.deepEqual(statusIssues, [], 'APPROVED should be recognized as a valid status');
    assert.ok(!result.reports.qa.myapp.failed, 'APPROVED should not be marked failed');
  });

  it('detects a QA report with canonical NEEDS_WORK status as failed', () => {
    const dir = setupDir('canonical-needs-work');
    fs.writeFileSync(path.join(dir, 'tests.check.md'), '**Changes Hash:** x\n✅ PASS');
    fs.writeFileSync(path.join(dir, 'code-review.check.md'), '**Changes Hash:** x\nNo issues');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), '**Changes Hash:** x\nCOMPLETE');
    fs.writeFileSync(path.join(dir, 'README.md'), 'readme');
    fs.writeFileSync(
      path.join(dir, 'qa-myapp.check.md'),
      buildQAReport('NEEDS_WORK').replace('Status: NEEDS_WORK', '❌ NEEDS_WORK\nStatus: NEEDS_WORK')
    );

    const { result } = runScript(dir, ['myapp']);
    assert.ok(result.reports.qa.myapp.exists, 'report should exist');
    // The key assertion: NEEDS_WORK must be detected as failed
    assert.ok(result.reports.qa.myapp.failed, 'NEEDS_WORK should be detected as failed');
  });

  it('does not false-positive when stale NEEDS_WORK appears in Previous Run section', () => {
    const dir = setupDir('stale-previous-run');
    fs.writeFileSync(path.join(dir, 'tests.check.md'), '**Changes Hash:** x\n✅ PASS');
    fs.writeFileSync(path.join(dir, 'code-review.check.md'), '**Changes Hash:** x\nNo issues');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), '**Changes Hash:** x\nCOMPLETE');
    fs.writeFileSync(path.join(dir, 'README.md'), 'readme');
    // Current run is APPROVED, but Previous Run section has NEEDS_WORK
    const report =
      buildQAReport('APPROVED') + '\n---\n# Previous Run\n---\nStatus: NEEDS_WORK\n❌ NEEDS_WORK\n';
    fs.writeFileSync(path.join(dir, 'qa-myapp.check.md'), report);

    const { result } = runScript(dir, ['myapp']);
    assert.ok(
      !result.reports.qa.myapp.failed,
      'stale NEEDS_WORK in Previous Run should not mark current run as failed'
    );
  });

  it('recognizes NEEDS_WORK in Status: line as a valid status (no missing-status issue)', () => {
    const dir = setupDir('canonical-needs-work-status');
    fs.writeFileSync(path.join(dir, 'tests.check.md'), '**Changes Hash:** x\n✅ PASS');
    fs.writeFileSync(path.join(dir, 'code-review.check.md'), '**Changes Hash:** x\nNo issues');
    fs.writeFileSync(path.join(dir, 'completion.check.md'), '**Changes Hash:** x\nCOMPLETE');
    fs.writeFileSync(path.join(dir, 'README.md'), 'readme');
    fs.writeFileSync(path.join(dir, 'qa-myapp.check.md'), buildQAReport('NEEDS_WORK'));

    const { result } = runScript(dir, ['myapp']);
    const statusIssues = result.reports.qa.myapp.issues.filter((i) => i.includes('Missing'));
    assert.deepEqual(statusIssues, [], 'NEEDS_WORK should be recognized as a valid status');
  });
});

// --- GH-280: Playwright requirements relaxed when the plan skipped 3_verify_playwright ---

const PLAYWRIGHT_ISSUE = 'Missing "## Playwright Verification" section';
const SCREENSHOT_ISSUE = 'No screenshots found - QA reports must include visual evidence';
const HASH_ISSUE = 'Missing "**Changes Hash:**" at top of report';

function seedBaseReports(dir) {
  fs.writeFileSync(path.join(dir, 'tests.check.md'), '**Changes Hash:** x\n✅ PASS');
  fs.writeFileSync(path.join(dir, 'code-review.check.md'), '**Changes Hash:** x\nNo issues');
  fs.writeFileSync(path.join(dir, 'completion.check.md'), '**Changes Hash:** x\nCOMPLETE');
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme');
}

describe('check-validate-reports.js — validateQAReport playwrightSkipped (GH-280)', () => {
  it('accepts a report without Playwright section/screenshots when skipped', () => {
    const dir = setupDir('pw-skip-unit-valid');
    const file = path.join(dir, 'qa-app.check.md');
    fs.writeFileSync(file, buildQAReportNoPlaywright('APPROVED'));

    const result = validateQAReport(file, 'app', true);
    assert.ok(result.valid, 'report should be valid when Playwright was skipped');
    assert.equal(result.playwrightSkipped, true);
    assert.ok(!result.issues.includes(PLAYWRIGHT_ISSUE));
    assert.ok(!result.issues.includes(SCREENSHOT_ISSUE));
  });

  it('still requires Playwright section + screenshots when NOT skipped', () => {
    const dir = setupDir('pw-skip-unit-required');
    const file = path.join(dir, 'qa-app.check.md');
    fs.writeFileSync(file, buildQAReportNoPlaywright('APPROVED'));

    const result = validateQAReport(file, 'app', false);
    assert.ok(!result.valid, 'report should be invalid when Playwright is required');
    assert.equal(result.playwrightSkipped, false);
    assert.ok(result.issues.includes(PLAYWRIGHT_ISSUE));
    assert.ok(result.issues.includes(SCREENSHOT_ISSUE));
  });

  it('defaults to NOT skipped when the arg is omitted', () => {
    const dir = setupDir('pw-skip-unit-default');
    const file = path.join(dir, 'qa-app.check.md');
    fs.writeFileSync(file, buildQAReportNoPlaywright('APPROVED'));

    const result = validateQAReport(file, 'app');
    assert.ok(result.issues.includes(PLAYWRIGHT_ISSUE));
    assert.equal(result.playwrightSkipped, false);
  });

  it('accepts an explicit "Status: APPROVED (SKIPPED)" report without the skip arg', () => {
    const dir = setupDir('pw-skip-inline-status');
    const file = path.join(dir, 'qa-app.check.md');
    fs.writeFileSync(file, buildQAReportNoPlaywright('APPROVED (SKIPPED)'));

    const result = validateQAReport(file, 'app', false);
    assert.ok(result.valid, 'APPROVED (SKIPPED) report should be accepted');
    assert.equal(result.playwrightSkipped, true);
    assert.ok(!result.failed, 'APPROVED (SKIPPED) must not be treated as failed');
  });

  it('other markers stay mandatory when skipped (Changes Hash)', () => {
    const dir = setupDir('pw-skip-hash-still-required');
    const file = path.join(dir, 'qa-app.check.md');
    fs.writeFileSync(file, buildQAReportNoPlaywright('APPROVED', { omitChangesHash: true }));

    const result = validateQAReport(file, 'app', true);
    assert.ok(!result.valid, 'missing Changes Hash should still invalidate the report');
    assert.ok(result.issues.includes(HASH_ISSUE));
  });

  it('a NEEDS_WORK report is still failed even when skipped', () => {
    const dir = setupDir('pw-skip-needswork');
    const file = path.join(dir, 'qa-app.check.md');
    fs.writeFileSync(file, buildQAReportNoPlaywright('NEEDS_WORK'));

    const result = validateQAReport(file, 'app', true);
    assert.ok(result.failed, 'NEEDS_WORK must be detected as failed regardless of skip');
  });
});

describe('check-validate-reports.js — CLI PLAYWRIGHT_SKIPPED_JSON arg (GH-280)', () => {
  it('3rd arg "true" relaxes Playwright checks and the run is APPROVED', () => {
    const dir = setupDir('cli-skip-true');
    seedBaseReports(dir);
    fs.writeFileSync(path.join(dir, 'qa-app.check.md'), buildQAReportNoPlaywright('APPROVED'));

    const { exitCode, result } = runScript(dir, ['app'], 'true');
    assert.equal(result.reports.qa.app.playwrightSkipped, true);
    assert.ok(!result.reports.qa.app.issues.includes(PLAYWRIGHT_ISSUE));
    assert.equal(result.overall.status, 'APPROVED');
    assert.equal(exitCode, 0);
  });

  it('per-app map relaxes only the named app', () => {
    const dir = setupDir('cli-skip-map');
    seedBaseReports(dir);
    fs.writeFileSync(path.join(dir, 'qa-app.check.md'), buildQAReportNoPlaywright('APPROVED'));
    fs.writeFileSync(path.join(dir, 'qa-web.check.md'), buildQAReportNoPlaywright('APPROVED'));

    const { result } = runScript(dir, ['app', 'web'], JSON.stringify({ app: true, web: false }));
    assert.equal(result.reports.qa.app.playwrightSkipped, true);
    assert.ok(!result.reports.qa.app.issues.includes(PLAYWRIGHT_ISSUE));
    assert.equal(result.reports.qa.web.playwrightSkipped, false);
    assert.ok(result.reports.qa.web.issues.includes(PLAYWRIGHT_ISSUE));
  });

  it('malformed skip JSON fails CLOSED (Playwright still required)', () => {
    const dir = setupDir('cli-skip-malformed');
    seedBaseReports(dir);
    fs.writeFileSync(path.join(dir, 'qa-app.check.md'), buildQAReportNoPlaywright('APPROVED'));

    const { result } = runScript(dir, ['app'], '{not-json');
    assert.equal(result.reports.qa.app.playwrightSkipped, false);
    assert.ok(result.reports.qa.app.issues.includes(PLAYWRIGHT_ISSUE));
  });

  it('legacy 2-arg invocation still requires Playwright evidence', () => {
    const dir = setupDir('cli-skip-legacy');
    seedBaseReports(dir);
    fs.writeFileSync(path.join(dir, 'qa-app.check.md'), buildQAReportNoPlaywright('APPROVED'));

    const { result } = runScript(dir, ['app']);
    assert.equal(result.reports.qa.app.playwrightSkipped, false);
    assert.ok(result.reports.qa.app.issues.includes(PLAYWRIGHT_ISSUE));
  });
});
