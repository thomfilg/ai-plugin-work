const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'check-validate-reports.js');
// Created with mkdtempSync in before() so the path is unpredictable (js/insecure-temporary-file).
let TEMP;

/** QA report missing Playwright section + screenshots, with standard markers. */
function buildQAReportNoPlaywright(statusToken) {
  return ['**Changes Hash:** abc123', '', `Status: ${statusToken}`, ''].join('\n');
}

function seedReports(dir) {
  fs.writeFileSync(path.join(dir, 'tests.check.md'), '**Changes Hash:** x\n✅ PASS');
  fs.writeFileSync(path.join(dir, 'code-review.check.md'), '**Changes Hash:** x\nNo issues');
  fs.writeFileSync(path.join(dir, 'completion.check.md'), '**Changes Hash:** x\nCOMPLETE');
  fs.writeFileSync(path.join(dir, 'README.md'), 'readme');
}

function setupDir(name) {
  const dir = path.join(TEMP, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function runCli(reportFolder, impactedAppsJson, playwrightSkippedArg) {
  const args = [SCRIPT, reportFolder, impactedAppsJson];
  if (playwrightSkippedArg !== undefined) args.push(playwrightSkippedArg);
  const res = spawnSync('node', args, { encoding: 'utf-8', timeout: 10000 });
  let result = null;
  try {
    result = JSON.parse(res.stdout);
  } catch (_) {
    /* ignore */
  }
  return { exitCode: res.status, result };
}

before(() => {
  TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'check-validate-reports-integ-'));
});

after(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
});

describe('check-validate-reports.js CLI — PLAYWRIGHT_SKIPPED_JSON 3rd arg', () => {
  it('boolean true relaxes Playwright checks for every app', () => {
    const dir = setupDir('bool-true');
    seedReports(dir);
    fs.writeFileSync(path.join(dir, 'qa-app.check.md'), buildQAReportNoPlaywright('APPROVED'));

    const { result } = runCli(dir, JSON.stringify(['app']), 'true');
    assert.equal(result.reports.qa.app.playwrightSkipped, true);
    assert.ok(
      !result.reports.qa.app.issues.includes('Missing "## Playwright Verification" section')
    );
  });

  it('per-app map relaxes only the named app', () => {
    const dir = setupDir('per-app-map');
    seedReports(dir);
    fs.writeFileSync(path.join(dir, 'qa-app.check.md'), buildQAReportNoPlaywright('APPROVED'));
    fs.writeFileSync(path.join(dir, 'qa-web.check.md'), buildQAReportNoPlaywright('APPROVED'));

    const { result } = runCli(
      dir,
      JSON.stringify(['app', 'web']),
      JSON.stringify({ app: true, web: false })
    );
    assert.equal(result.reports.qa.app.playwrightSkipped, true);
    assert.equal(result.reports.qa.web.playwrightSkipped, false);
    assert.ok(
      result.reports.qa.web.issues.includes('Missing "## Playwright Verification" section')
    );
  });

  it('malformed JSON fails closed (playwrightSkipped false)', () => {
    const dir = setupDir('malformed');
    seedReports(dir);
    fs.writeFileSync(path.join(dir, 'qa-app.check.md'), buildQAReportNoPlaywright('APPROVED'));

    const { result } = runCli(dir, JSON.stringify(['app']), '{not json');
    assert.equal(result.reports.qa.app.playwrightSkipped, false);
    assert.ok(
      result.reports.qa.app.issues.includes('Missing "## Playwright Verification" section'),
      'fail-closed: Playwright still required on malformed signal'
    );
  });

  it('legacy 2-arg invocation preserved (defaults to not skipped)', () => {
    const dir = setupDir('legacy-2arg');
    seedReports(dir);
    fs.writeFileSync(path.join(dir, 'qa-app.check.md'), buildQAReportNoPlaywright('APPROVED'));

    const { result } = runCli(dir, JSON.stringify(['app']));
    assert.equal(result.reports.qa.app.playwrightSkipped, false);
    assert.ok(
      result.reports.qa.app.issues.includes('Missing "## Playwright Verification" section')
    );
  });
});
