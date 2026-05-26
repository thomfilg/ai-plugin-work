const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const WRITE_REPORT = path.join(__dirname, '..', 'write-report.js');
const { tokenPath, ensureTokenDir, TOKEN_MAX_AGE_MS } = require(WRITE_REPORT);

const QA_SCRIPT = path.join(__dirname, '..', '..', '..', 'check', 'scripts', 'write-qa-report.js');
const TESTS_SCRIPT = path.join(
  __dirname,
  '..',
  '..',
  '..',
  'check',
  'scripts',
  'write-tests-report.js'
);

const REPORT_PATH = '/tmp/write-report-test-output.check.md';

function writeToken(scriptBasename, agent, timestamp) {
  ensureTokenDir();
  const tp = tokenPath(scriptBasename);
  try {
    fs.unlinkSync(tp);
  } catch {
    /* ignore */
  }
  fs.writeFileSync(tp, JSON.stringify({ agent, timestamp, tasksBase: '/tmp' }), { mode: 0o600 });
}

function cleanupToken(scriptBasename) {
  try {
    fs.unlinkSync(tokenPath(scriptBasename));
  } catch {
    /* ignore */
  }
}

function runScript(scriptPath, input, env = {}) {
  const fullEnv = { ...process.env, ...env };
  try {
    const stdout = execSync(
      `echo '${JSON.stringify(input).replace(/'/g, "'\\''")}' | node "${scriptPath}" 2>&1`,
      {
        env: fullEnv,
        encoding: 'utf8',
        timeout: 5000,
      }
    );
    return { exitCode: 0, output: stdout };
  } catch (e) {
    return { exitCode: e.status, output: e.stdout || e.stderr || '' };
  }
}

const validQAInput = {
  reportPath: '/tmp/qa-test-runner.check.md',
  changesHash: 'abc123',
  appName: 'test-app',
  appUrl: 'http://localhost:5175',
  status: 'PASS',
  playwrightVerification: {
    toolsUsed: ['mcp__playwright__browser_navigate'],
    externalConnectivity: { url: 'https://google.com', success: true, evidence: 'ok' },
    appHealthCheck: { url: 'http://localhost:5175', success: true, evidence: 'ok' },
  },
  tests: [{ name: 'test1', status: 'pass' }],
  screenshots: [{ path: 's.png', description: 'test' }],
};

describe('write-report', () => {
  afterEach(() => {
    cleanupToken('write-qa-report.js');
    cleanupToken('write-tests-report.js');
    try {
      fs.unlinkSync('/tmp/qa-test-runner.check.md');
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync('/tmp/tests-test-runner.check.md');
    } catch {
      /* ignore */
    }
  });

  describe('tokenPath', () => {
    it('builds path under private token directory', () => {
      const tp = tokenPath('write-qa-report.js');
      assert.ok(tp.includes('.claude-write-tokens'));
      assert.ok(tp.endsWith('write-qa-report.js'));
    });
  });

  describe('TOKEN_MAX_AGE_MS', () => {
    it('is 10 seconds', () => {
      assert.equal(TOKEN_MAX_AGE_MS, 10_000);
    });
  });

  describe('token enforcement', () => {
    it('blocks when no token exists', () => {
      const result = runScript(QA_SCRIPT, validQAInput);
      assert.equal(result.exitCode, 2);
      assert.ok(result.output.includes('No valid write token found'));
    });

    it('blocks when token has wrong agent', () => {
      writeToken('write-qa-report.js', 'quality-checker', Date.now());
      const result = runScript(QA_SCRIPT, validQAInput);
      assert.equal(result.exitCode, 2);
      assert.ok(result.output.includes('not authorized'));
    });

    it('blocks when token is expired', () => {
      writeToken('write-qa-report.js', 'qa-feature-tester', Date.now() - 20_000);
      const result = runScript(QA_SCRIPT, validQAInput);
      assert.equal(result.exitCode, 2);
      assert.ok(result.output.includes('expired'));
    });

    it('blocks when token has missing timestamp', () => {
      ensureTokenDir();
      const tp = tokenPath('write-qa-report.js');
      try {
        fs.unlinkSync(tp);
      } catch {
        /* ignore */
      }
      fs.writeFileSync(tp, JSON.stringify({ agent: 'qa-feature-tester' }), { mode: 0o600 });
      const result = runScript(QA_SCRIPT, validQAInput);
      assert.equal(result.exitCode, 2);
      assert.ok(result.output.includes('invalid or missing timestamp'));
    });

    it('blocks when token has missing agent', () => {
      ensureTokenDir();
      const tp = tokenPath('write-qa-report.js');
      try {
        fs.unlinkSync(tp);
      } catch {
        /* ignore */
      }
      fs.writeFileSync(tp, JSON.stringify({ timestamp: Date.now() }), { mode: 0o600 });
      const result = runScript(QA_SCRIPT, validQAInput);
      assert.equal(result.exitCode, 2);
      assert.ok(result.output.includes('invalid or missing agent'));
    });

    it('allows with valid token and correct agent', () => {
      writeToken('write-qa-report.js', 'qa-feature-tester', Date.now());
      const result = runScript(QA_SCRIPT, validQAInput);
      assert.equal(result.exitCode, 0);
      assert.ok(result.output.includes('"success": true'));
    });

    it('consumes token — second call fails', () => {
      writeToken('write-qa-report.js', 'qa-feature-tester', Date.now());
      const first = runScript(QA_SCRIPT, validQAInput);
      assert.equal(first.exitCode, 0);

      const second = runScript(QA_SCRIPT, validQAInput);
      assert.equal(second.exitCode, 2);
      assert.ok(second.output.includes('No valid write token found'));
    });
  });

  describe('field validation', () => {
    it('blocks when required fields are missing', () => {
      writeToken('write-qa-report.js', 'qa-feature-tester', Date.now());
      const input = { ...validQAInput, changesHash: '' };
      const result = runScript(QA_SCRIPT, input);
      assert.equal(result.exitCode, 1);
      assert.ok(result.output.includes('Missing required field'));
    });

    it('blocks invalid QA status', () => {
      writeToken('write-qa-report.js', 'qa-feature-tester', Date.now());
      const input = { ...validQAInput, status: 'INVALID' };
      const result = runScript(QA_SCRIPT, input);
      assert.equal(result.exitCode, 1);
      assert.ok(result.output.includes('Invalid status'));
    });

    it('blocks wrong report path basename', () => {
      writeToken('write-qa-report.js', 'qa-feature-tester', Date.now());
      const input = { ...validQAInput, reportPath: '/tmp/wrong-name.md' };
      const result = runScript(QA_SCRIPT, input);
      assert.equal(result.exitCode, 1);
      assert.ok(result.output.includes('qa-*.check.md'));
    });
  });

  describe('report output', () => {
    it('writes correctly formatted QA report', () => {
      writeToken('write-qa-report.js', 'qa-feature-tester', Date.now());
      const result = runScript(QA_SCRIPT, validQAInput);
      assert.equal(result.exitCode, 0);

      const content = fs.readFileSync('/tmp/qa-test-runner.check.md', 'utf8');
      assert.ok(content.includes('**Changes Hash:** abc123'));
      assert.ok(content.includes('# QA Report: test-app'));
      assert.ok(content.includes('## Playwright Verification'));
      assert.ok(content.includes('### External Connectivity (google.com)'));
      assert.ok(content.includes('### App Health Check'));
      assert.ok(content.includes('mcp__playwright__browser_navigate'));
      assert.ok(content.includes('**PASS**'));
    });

    it('prepends new content when file exists', () => {
      // Write initial report
      writeToken('write-qa-report.js', 'qa-feature-tester', Date.now());
      runScript(QA_SCRIPT, validQAInput);

      // Write second report — should prepend
      writeToken('write-qa-report.js', 'qa-feature-tester', Date.now());
      const input2 = { ...validQAInput, changesHash: 'def456' };
      runScript(QA_SCRIPT, input2);

      const content = fs.readFileSync('/tmp/qa-test-runner.check.md', 'utf8');
      // New content should be first
      const idx1 = content.indexOf('def456');
      const idx2 = content.indexOf('abc123');
      assert.ok(idx1 < idx2, 'New content should appear before old content');
      assert.ok(content.includes('## Previous Run:'));
    });
  });

  describe('cross-agent enforcement', () => {
    it('quality-checker cannot call QA writer', () => {
      writeToken('write-qa-report.js', 'quality-checker', Date.now());
      const result = runScript(QA_SCRIPT, validQAInput);
      assert.equal(result.exitCode, 2);
      assert.ok(result.output.includes('not authorized'));
    });

    it('qa-feature-tester cannot call tests writer', () => {
      writeToken('write-tests-report.js', 'qa-feature-tester', Date.now());
      const input = {
        reportPath: '/tmp/tests-test-runner.check.md',
        changesHash: 'abc',
        qualityGate: { output: 'ok', exitCode: 0, tier: 'Tier 1' },
        unitTests: { status: 'pass', count: '1/1', exitCode: 0, output: 'ok' },
      };
      const result = runScript(TESTS_SCRIPT, input);
      assert.equal(result.exitCode, 2);
      assert.ok(result.output.includes('not authorized'));
    });
  });

  // ─── GH-326 Task 1.4: Post-write validation ──────────────────────────────
  describe('post-write validation (GH-326)', () => {
    it('rejects formatted output without Status line when reportType is set', () => {
      // createReportWriter with reportType should validate formatReport output.
      // A formatReport that returns content without a Status: line should cause
      // the writer to exit with error.
      const { createReportWriter } = require(WRITE_REPORT);

      // We test by creating a writer with a reportType and a formatReport that
      // omits the Status line, then running it via the script pattern.
      // Since createReportWriter reads from stdin, we need a helper script.
      const helperScript = path.join('/tmp', 'test-write-report-validation-no-status.js');
      fs.writeFileSync(
        helperScript,
        `
        const { createReportWriter } = require('${WRITE_REPORT.replace(/\\/g, '\\\\')}');
        createReportWriter({
          name: 'Test Writer',
          allowedAgents: ['test-agent'],
          requiredFields: ['reportPath'],
          reportType: 'tests',
          formatReport: () => '# Test Report\\nAll tests pass\\nNo Status line here',
        }).run();
        `,
        'utf8'
      );

      writeToken(path.basename(helperScript), 'test-agent', Date.now());
      const result = runScript(helperScript, { reportPath: REPORT_PATH });
      // Should fail because formatted output has no valid Status line
      assert.notEqual(result.exitCode, 0, 'should reject output without Status line');
      assert.ok(
        result.output.includes('Status') || result.output.includes('status'),
        'error should mention Status'
      );

      try {
        fs.unlinkSync(helperScript);
      } catch {
        /* ignore */
      }
    });

    it('accepts formatted output with valid Status line when reportType is set', () => {
      const helperScript = path.join('/tmp', 'test-write-report-validation-with-status.js');
      fs.writeFileSync(
        helperScript,
        `
        const { createReportWriter } = require('${WRITE_REPORT.replace(/\\/g, '\\\\')}');
        createReportWriter({
          name: 'Test Writer',
          allowedAgents: ['test-agent'],
          requiredFields: ['reportPath'],
          reportType: 'tests',
          formatReport: () => 'Status: APPROVED\\n# Test Report\\nAll tests pass',
        }).run();
        `,
        'utf8'
      );

      writeToken(path.basename(helperScript), 'test-agent', Date.now());
      const result = runScript(helperScript, { reportPath: REPORT_PATH });
      assert.equal(result.exitCode, 0, 'should accept output with valid Status line');

      try {
        fs.unlinkSync(helperScript);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(REPORT_PATH);
      } catch {
        /* ignore */
      }
    });

    it('skips validation when reportType is not set (backward compat)', () => {
      const helperScript = path.join('/tmp', 'test-write-report-validation-no-type.js');
      fs.writeFileSync(
        helperScript,
        `
        const { createReportWriter } = require('${WRITE_REPORT.replace(/\\/g, '\\\\')}');
        createReportWriter({
          name: 'Test Writer',
          allowedAgents: ['test-agent'],
          requiredFields: ['reportPath'],
          formatReport: () => '# Report\\nNo Status line but no reportType either',
        }).run();
        `,
        'utf8'
      );

      writeToken(path.basename(helperScript), 'test-agent', Date.now());
      const result = runScript(helperScript, { reportPath: REPORT_PATH });
      assert.equal(result.exitCode, 0, 'should skip validation when no reportType');

      try {
        fs.unlinkSync(helperScript);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(REPORT_PATH);
      } catch {
        /* ignore */
      }
    });
  });

  // ─── GH-331 Task 1.2: write-qa-report formatReport status mapping ─────────
  describe('write-qa-report formatReport status mapping (GH-331)', () => {
    afterEach(() => {
      cleanupToken('write-qa-report.js');
      try {
        fs.unlinkSync('/tmp/qa-test-runner.check.md');
      } catch {
        /* ignore */
      }
    });

    it('outputs "Status: APPROVED" when input status is PASS', () => {
      writeToken('write-qa-report.js', 'qa-feature-tester', Date.now());
      const input = { ...validQAInput, status: 'PASS' };
      const result = runScript(QA_SCRIPT, input);
      assert.equal(result.exitCode, 0, `script failed: ${result.output}`);

      const content = fs.readFileSync('/tmp/qa-test-runner.check.md', 'utf8');
      const statusLine = content.match(/^Status:\s*(\S+)/m);
      assert.ok(statusLine, 'report must contain a Status: line');
      assert.equal(statusLine[1], 'APPROVED', 'PASS input must produce Status: APPROVED');
    });

    it('outputs "Status: NEEDS_WORK" when input status is FAIL', () => {
      writeToken('write-qa-report.js', 'qa-feature-tester', Date.now());
      const input = {
        ...validQAInput,
        status: 'FAIL',
        tests: [{ name: 'test1', status: 'fail' }],
      };
      const result = runScript(QA_SCRIPT, input);
      assert.equal(result.exitCode, 0, `script failed: ${result.output}`);

      const content = fs.readFileSync('/tmp/qa-test-runner.check.md', 'utf8');
      const statusLine = content.match(/^Status:\s*(\S+)/m);
      assert.ok(statusLine, 'report must contain a Status: line');
      assert.equal(statusLine[1], 'NEEDS_WORK', 'FAIL input must produce Status: NEEDS_WORK');
    });

    it('outputs "Status: NEEDS_WORK" when input status is INFRASTRUCTURE_FAILURE', () => {
      writeToken('write-qa-report.js', 'qa-feature-tester', Date.now());
      const input = {
        ...validQAInput,
        status: 'INFRASTRUCTURE_FAILURE',
        screenshots: [],
        mcpDiagnostics: 'Playwright not available',
      };
      const result = runScript(QA_SCRIPT, input);
      assert.equal(result.exitCode, 0, `script failed: ${result.output}`);

      const content = fs.readFileSync('/tmp/qa-test-runner.check.md', 'utf8');
      const statusLine = content.match(/^Status:\s*(\S+)/m);
      assert.ok(statusLine, 'report must contain a Status: line');
      assert.equal(
        statusLine[1],
        'NEEDS_WORK',
        'INFRASTRUCTURE_FAILURE input must produce Status: NEEDS_WORK'
      );
    });

    it('outputs "Status: NEEDS_WORK" when input status is ACCESS_FAILED', () => {
      writeToken('write-qa-report.js', 'qa-feature-tester', Date.now());
      const input = {
        ...validQAInput,
        status: 'ACCESS_FAILED',
        screenshots: [],
        mcpDiagnostics: 'Could not reach app',
      };
      const result = runScript(QA_SCRIPT, input);
      assert.equal(result.exitCode, 0, `script failed: ${result.output}`);

      const content = fs.readFileSync('/tmp/qa-test-runner.check.md', 'utf8');
      const statusLine = content.match(/^Status:\s*(\S+)/m);
      assert.ok(statusLine, 'report must contain a Status: line');
      assert.equal(
        statusLine[1],
        'NEEDS_WORK',
        'ACCESS_FAILED input must produce Status: NEEDS_WORK'
      );
    });

    it('outputs "Status: NEEDS_WORK" when input status is BLOCKED', () => {
      writeToken('write-qa-report.js', 'qa-feature-tester', Date.now());
      const input = {
        ...validQAInput,
        status: 'BLOCKED',
        screenshots: [],
      };
      const result = runScript(QA_SCRIPT, input);
      assert.equal(result.exitCode, 0, `script failed: ${result.output}`);

      const content = fs.readFileSync('/tmp/qa-test-runner.check.md', 'utf8');
      const statusLine = content.match(/^Status:\s*(\S+)/m);
      assert.ok(statusLine, 'report must contain a Status: line');
      assert.equal(statusLine[1], 'NEEDS_WORK', 'BLOCKED input must produce Status: NEEDS_WORK');
    });
  });

  // ─── GH-331 Task 1.3: write-qa-report reportType validation ───────────────
  describe('write-qa-report reportType: qa validation (GH-331)', () => {
    afterEach(() => {
      cleanupToken('write-qa-report.js');
      try {
        fs.unlinkSync('/tmp/qa-test-runner.check.md');
      } catch {
        /* ignore */
      }
    });

    it('has reportType set to qa in createReportWriter config', () => {
      // Verify by reading the source file and checking for reportType: 'qa'
      const qaSource = fs.readFileSync(QA_SCRIPT, 'utf8');
      assert.ok(
        /reportType:\s*['"]qa['"]/.test(qaSource),
        'write-qa-report.js must configure reportType: "qa" in createReportWriter config'
      );
    });

    it('post-write validation succeeds for PASS status (reportType fires)', () => {
      // When reportType: 'qa' is set, the post-write validation in write-report.js
      // will verify that the formatted output has a parseable Status line.
      // This test verifies the full pipeline works with reportType active.
      writeToken('write-qa-report.js', 'qa-feature-tester', Date.now());
      const input = { ...validQAInput, status: 'PASS' };
      const result = runScript(QA_SCRIPT, input);
      assert.equal(result.exitCode, 0, `post-write validation should pass: ${result.output}`);
      assert.ok(result.output.includes('"success": true'));
    });
  });
});
