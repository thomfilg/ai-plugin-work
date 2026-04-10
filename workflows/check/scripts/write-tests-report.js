#!/usr/bin/env node
/**
 * write-tests-report.js — Test Results Report Writer (agent-gated)
 *
 * ONLY callable by: quality-checker
 *
 * Accepts JSON via stdin with test results, validates, and writes tests.check.md.
 *
 * Usage (from quality-checker agent via Bash):
 *   echo '<json>' | node workflows/check/scripts/write-tests-report.js
 *
 * Required JSON fields:
 *   - reportPath: string      — Full path (e.g. .../tests.check.md)
 *   - changesHash: string     — Git changes hash
 *   - qualityGate: object     — { output: string, exitCode: number, tier: string }
 *   - unitTests: object       — { status: "pass"|"fail"|"na", count: string, exitCode: number, output: string }
 *
 * Optional fields:
 *   - integrationTests: object — { status, count, exitCode, output }
 *   - smokeTests: object       — { status, count, exitCode, output }
 *   - verdict: string          — "APPROVED" | "NEEDS_WORK"
 */

const { createReportWriter } = require('../../lib/scripts/write-report');

const writer = createReportWriter({
  name: 'Tests Report Writer',

  allowedAgents: ['quality-checker'],

  requiredFields: ['reportPath', 'changesHash', 'qualityGate', 'unitTests'],

  validate(input) {
    const errors = [];

    // Quality gate must have output
    if (!input.qualityGate.output) {
      errors.push('qualityGate.output is required (full command output)');
    }
    if (input.qualityGate.exitCode === undefined) {
      errors.push('qualityGate.exitCode is required');
    }

    // Unit tests must have status
    if (!['pass', 'fail', 'na'].includes(input.unitTests.status)) {
      errors.push(
        `unitTests.status must be "pass", "fail", or "na" (got "${input.unitTests.status}")`
      );
    }

    // Report path must be tests.check.md
    const basename = require('path').basename(input.reportPath || '');
    if (basename !== 'tests.check.md') {
      errors.push(`reportPath basename must be "tests.check.md" (got "${basename}")`);
    }

    return errors;
  },

  formatReport(input) {
    const lines = [];
    const timestamp = new Date().toISOString();

    const verdict =
      input.verdict || (input.unitTests.status === 'pass' ? 'APPROVED' : 'NEEDS_WORK');
    lines.push(`**Changes Hash:** ${input.changesHash}`);
    lines.push(`Status: ${verdict}`);
    lines.push('');
    lines.push('# Test Results Report');
    lines.push('');
    lines.push(`- **Date:** ${timestamp}`);
    lines.push('');

    // Quality Gate
    lines.push('## Quality Gate');
    lines.push('');
    lines.push(`- **Tier:** ${input.qualityGate.tier || 'N/A'}`);
    lines.push(`- **Exit code:** ${input.qualityGate.exitCode}`);
    lines.push('');
    lines.push('```');
    lines.push(input.qualityGate.output);
    lines.push('```');
    lines.push('');

    // Unit Tests
    const ut = input.unitTests;
    lines.push('## Unit Tests');
    lines.push('');
    if (ut.output) {
      lines.push('```');
      lines.push(ut.output);
      lines.push('```');
    }
    lines.push(
      `- Status: ${ut.status === 'pass' ? '✅ PASS' : ut.status === 'fail' ? '❌ FAIL' : 'N/A'}`
    );
    lines.push(`- Count: ${ut.count || 'N/A'}`);
    lines.push(`- Exit code: ${ut.exitCode ?? 'N/A'}`);
    lines.push('');

    // Integration Tests
    const it = input.integrationTests;
    lines.push('## Integration Tests');
    lines.push('');
    if (it && it.status !== 'na') {
      if (it.output) {
        lines.push('```');
        lines.push(it.output);
        lines.push('```');
      }
      lines.push(`- Status: ${it.status === 'pass' ? '✅ PASS' : '❌ FAIL'}`);
      lines.push(`- Count: ${it.count || 'N/A'}`);
    } else {
      lines.push('N/A - no integration tests found');
    }
    lines.push('');

    // Smoke Tests
    const st = input.smokeTests;
    lines.push('## Smoke Tests');
    lines.push('');
    if (st && st.status !== 'na') {
      if (st.output) {
        lines.push('```');
        lines.push(st.output);
        lines.push('```');
      }
      lines.push(`- Status: ${st.status === 'pass' ? '✅ PASS' : '❌ FAIL'}`);
      lines.push(`- Count: ${st.count || 'N/A'}`);
    } else {
      lines.push('N/A - no smoke tests found');
    }
    lines.push('');

    // Summary table
    lines.push('## Summary');
    lines.push('');
    lines.push('| Test Type | Status | Count |');
    lines.push('|-----------|--------|-------|');
    lines.push(
      `| Unit | ${ut.status === 'pass' ? '✅' : ut.status === 'fail' ? '❌' : 'N/A'} | ${ut.count || 'N/A'} |`
    );
    lines.push(
      `| Integration | ${it?.status === 'pass' ? '✅' : it?.status === 'fail' ? '❌' : 'N/A'} | ${it?.count || 'N/A'} |`
    );
    lines.push(
      `| Smoke | ${st?.status === 'pass' ? '✅' : st?.status === 'fail' ? '❌' : 'N/A'} | ${st?.count || 'N/A'} |`
    );
    lines.push('');

    // Verdict (reuse verdict from top of formatReport)
    lines.push('## Final Verdict');
    lines.push('');
    lines.push(`**${verdict}**${verdict === 'APPROVED' ? ' - All tests pass' : ''}`);
    lines.push('');

    return lines.join('\n');
  },
});

writer.run().catch((err) => {
  process.stderr.write(`[Tests Report Writer] Unexpected error: ${err.message}\n`);
  process.exit(1);
});
