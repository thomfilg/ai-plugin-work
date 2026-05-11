const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', 'validate-qa-report.js');
const TEMP = path.join(os.tmpdir(), 'validate-qa-report-test-' + process.pid);

/**
 * Build a minimal valid QA report with the given status in a table row
 * and a Status: line. Includes all required sections.
 */
function buildQAReport(statusToken, opts = {}) {
  const screenshotLine = opts.noScreenshots ? '' : '![screenshot](./screenshots/test.png)\n';
  const browserEvidence = opts.noBrowserEvidence
    ? ''
    : '`mcp__playwright__navigate` Result: SUCCESS\n';
  const infraLine = opts.infraFailure
    ? 'INFRASTRUCTURE_FAILURE\n## MCP Diagnostics\nListMcpResourcesTool\n'
    : '';
  const accessLine = opts.accessFailed
    ? 'ACCESS_FAILED\n## MCP Diagnostics\nListMcpResourcesTool\n'
    : '';

  return [
    '# QA Report',
    '',
    '## Playwright Verification',
    '',
    browserEvidence,
    screenshotLine,
    '| Test | Status |',
    '|------|--------|',
    `| Login | ${statusToken} |`,
    '',
    `Status: ${statusToken}`,
    '',
    infraLine,
    accessLine,
  ].join('\n');
}

/**
 * Run the validate-qa-report.js script by piping stdin, return exit code and stderr.
 */
function runScript(reportPath) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRIPT], { timeout: 10000 });
    let stderr = '';
    let stdout = '';

    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.stdout.on('data', (d) => {
      stdout += d;
    });

    const stdinData = JSON.stringify({
      task_prompt: `REPORT_PATH: ${reportPath}`,
    });
    child.stdin.write(stdinData);
    child.stdin.end();

    child.on('close', (code) => {
      resolve({ exitCode: code, stderr, stdout });
    });
    child.on('error', reject);
  });
}

before(() => {
  fs.mkdirSync(TEMP, { recursive: true });
});

after(() => {
  fs.rmSync(TEMP, { recursive: true, force: true });
});

describe('validate-qa-report.js — hasTestStatus canonical status matching', () => {
  // --- Backward compat: legacy statuses ---

  it('accepts a QA report with legacy PASS status in table', async () => {
    const reportPath = path.join(TEMP, 'qa-legacy-pass.check.md');
    fs.writeFileSync(reportPath, buildQAReport('PASS'));

    const { exitCode, stderr } = await runScript(reportPath);
    assert.equal(exitCode, 0, `Should pass validation, stderr: ${stderr}`);
  });

  it('accepts a QA report with legacy FAIL status in table', async () => {
    const reportPath = path.join(TEMP, 'qa-legacy-fail.check.md');
    fs.writeFileSync(reportPath, buildQAReport('FAIL'));

    const { exitCode, stderr } = await runScript(reportPath);
    assert.equal(exitCode, 0, `Should pass validation, stderr: ${stderr}`);
  });

  // --- Canonical statuses ---

  it('accepts a QA report with canonical APPROVED status in table', async () => {
    const reportPath = path.join(TEMP, 'qa-canonical-approved.check.md');
    fs.writeFileSync(reportPath, buildQAReport('APPROVED'));

    const { exitCode, stderr } = await runScript(reportPath);
    assert.equal(exitCode, 0, `APPROVED should be accepted, stderr: ${stderr}`);
  });

  it('accepts a QA report with canonical NEEDS_WORK status in table', async () => {
    const reportPath = path.join(TEMP, 'qa-canonical-needs-work.check.md');
    fs.writeFileSync(reportPath, buildQAReport('NEEDS_WORK'));

    const { exitCode, stderr } = await runScript(reportPath);
    assert.equal(exitCode, 0, `NEEDS_WORK should be accepted, stderr: ${stderr}`);
  });

  it('accepts a QA report with APPROVED in Status: line only', async () => {
    const reportPath = path.join(TEMP, 'qa-status-line-approved.check.md');
    // Report with APPROVED only in the Status: line (not in table)
    const content = [
      '# QA Report',
      '',
      '## Playwright Verification',
      '',
      '`mcp__playwright__navigate` Result: SUCCESS',
      '',
      '![screenshot](./screenshots/test.png)',
      '',
      'Status: APPROVED',
      '',
    ].join('\n');
    fs.writeFileSync(reportPath, content);

    const { exitCode, stderr } = await runScript(reportPath);
    assert.equal(exitCode, 0, `APPROVED in Status: line should be accepted, stderr: ${stderr}`);
  });

  it('accepts a QA report with NEEDS_WORK in Status: line only', async () => {
    const reportPath = path.join(TEMP, 'qa-status-line-needs-work.check.md');
    const content = [
      '# QA Report',
      '',
      '## Playwright Verification',
      '',
      '`mcp__playwright__navigate` Result: SUCCESS',
      '',
      '![screenshot](./screenshots/test.png)',
      '',
      'Status: NEEDS_WORK',
      '',
    ].join('\n');
    fs.writeFileSync(reportPath, content);

    const { exitCode, stderr } = await runScript(reportPath);
    assert.equal(exitCode, 0, `NEEDS_WORK in Status: line should be accepted, stderr: ${stderr}`);
  });
});
