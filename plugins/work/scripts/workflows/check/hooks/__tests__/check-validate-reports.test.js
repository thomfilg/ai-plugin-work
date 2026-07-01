const { describe, it, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'check-validate-reports.js');
const { validateQAReport } = require(SCRIPT);
// Created with mkdtempSync in before() so the path is unpredictable (js/insecure-temporary-file).
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
 * Build a minimal QA report that is MISSING the Playwright Verification section
 * and screenshots, but still carries the standard markers.
 */
function buildQAReportNoPlaywright(statusToken, opts = {}) {
  const lines = ['**Changes Hash:** abc123', '', `Status: ${statusToken}`, ''];
  if (opts.omitChangesHash) {
    lines.shift(); // drop "**Changes Hash:**"
    lines.shift(); // drop the blank line after it
  }
  return lines.join('\n');
}

/**
 * Run the validate-reports script and return parsed JSON + exit code.
 * Optionally pass a 3rd CLI arg (PLAYWRIGHT_SKIPPED_JSON) verbatim.
 */
function runScript(reportFolder, impactedApps, playwrightSkippedArg) {
  const args = [SCRIPT, reportFolder];
  args.push(typeof impactedApps === 'string' ? impactedApps : JSON.stringify(impactedApps));
  if (playwrightSkippedArg !== undefined) {
    args.push(playwrightSkippedArg);
  }
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

const PLAYWRIGHT_ISSUE = 'Missing "## Playwright Verification" section';
const SCREENSHOT_ISSUE = 'No screenshots found - QA reports must include visual evidence';
const CHANGES_HASH_ISSUE = 'Missing "**Changes Hash:**" at top of report';

// --- Task 2: playwrightSkipped support ---

test('P0 #1 — QA report without Playwright section is APPROVED when playwright-skipped flag is set', () => {
  const dir = setupDir('pw-skipped-valid');
  const file = path.join(dir, 'qa-app.check.md');
  fs.writeFileSync(file, buildQAReportNoPlaywright('APPROVED'));

  const result = validateQAReport(file, 'app', true);
  assert.ok(result.valid, 'report should be valid when playwright is skipped');
  assert.ok(
    !result.issues.includes(PLAYWRIGHT_ISSUE),
    'should not flag missing Playwright section when skipped'
  );
  assert.ok(
    !result.issues.includes(SCREENSHOT_ISSUE),
    'should not flag missing screenshots when skipped'
  );
});

test('P0 #4 — Web-app QA report still requires Playwright section when not skipped', () => {
  const dir = setupDir('pw-not-skipped-invalid');
  const file = path.join(dir, 'qa-app.check.md');
  fs.writeFileSync(file, buildQAReportNoPlaywright('APPROVED'));

  const result = validateQAReport(file, 'app', false);
  assert.ok(!result.valid, 'report should be invalid when playwright is required');
  assert.ok(
    result.issues.includes(PLAYWRIGHT_ISSUE),
    'should flag missing Playwright section when not skipped'
  );
  assert.ok(
    result.issues.includes(SCREENSHOT_ISSUE),
    'should flag missing screenshots when not skipped'
  );
});

test('P0 #3 — Standard markers still required when Playwright is skipped', () => {
  const dir = setupDir('pw-skipped-no-hash');
  const file = path.join(dir, 'qa-app.check.md');
  fs.writeFileSync(file, buildQAReportNoPlaywright('APPROVED', { omitChangesHash: true }));

  const result = validateQAReport(file, 'app', true);
  assert.ok(!result.valid, 'report missing Changes Hash should be invalid even when skipped');
  assert.ok(
    result.issues.includes(CHANGES_HASH_ISSUE),
    'should flag missing Changes Hash even when playwright is skipped'
  );
});

test('P1 — JSON output records playwrightSkipped per app', () => {
  const dir = setupDir('pw-skipped-flag');
  const file = path.join(dir, 'qa-app.check.md');
  fs.writeFileSync(file, buildQAReportNoPlaywright('APPROVED'));

  assert.equal(validateQAReport(file, 'app', true).playwrightSkipped, true);
  assert.equal(validateQAReport(file, 'app', false).playwrightSkipped, false);
  assert.equal(validateQAReport(file, 'app').playwrightSkipped, false);
});

test('CLI: 3rd arg "true" relaxes Playwright checks and records playwrightSkipped per app', () => {
  const dir = setupDir('cli-skip-true');
  fs.writeFileSync(path.join(dir, 'tests.check.md'), '**Changes Hash:** x\n✅ PASS');
  fs.writeFileSync(path.join(dir, 'code-review.check.md'), '**Changes Hash:** x\nNo issues');
  fs.writeFileSync(path.join(dir, 'completion.check.md'), '**Changes Hash:** x\nCOMPLETE');
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme');
  fs.writeFileSync(path.join(dir, 'qa-app.check.md'), buildQAReportNoPlaywright('APPROVED'));

  const { result } = runScript(dir, ['app'], 'true');
  assert.equal(result.reports.qa.app.playwrightSkipped, true);
  assert.ok(
    !result.reports.qa.app.issues.includes(PLAYWRIGHT_ISSUE),
    'no Playwright issue when skipped via CLI'
  );
});

test('CLI: 3rd arg per-app map relaxes only the named app', () => {
  const dir = setupDir('cli-skip-map');
  fs.writeFileSync(path.join(dir, 'tests.check.md'), '**Changes Hash:** x\n✅ PASS');
  fs.writeFileSync(path.join(dir, 'code-review.check.md'), '**Changes Hash:** x\nNo issues');
  fs.writeFileSync(path.join(dir, 'completion.check.md'), '**Changes Hash:** x\nCOMPLETE');
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme');
  fs.writeFileSync(path.join(dir, 'qa-app.check.md'), buildQAReportNoPlaywright('APPROVED'));
  fs.writeFileSync(path.join(dir, 'qa-other.check.md'), buildQAReportNoPlaywright('APPROVED'));

  const { result } = runScript(dir, ['app', 'other'], JSON.stringify({ app: true, other: false }));
  assert.equal(result.reports.qa.app.playwrightSkipped, true);
  assert.equal(result.reports.qa.other.playwrightSkipped, false);
  assert.ok(
    !result.reports.qa.app.issues.includes(PLAYWRIGHT_ISSUE),
    'app should be relaxed in per-app map'
  );
  assert.ok(
    result.reports.qa.other.issues.includes(PLAYWRIGHT_ISSUE),
    'other should still require Playwright section'
  );
});
