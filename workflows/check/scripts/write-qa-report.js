#!/usr/bin/env node
/**
 * write-qa-report.js — QA Report Writer (agent-gated)
 *
 * ONLY callable by: qa-feature-tester, qa-api-tester
 *
 * Accepts JSON via stdin with all required QA report fields,
 * validates them, and writes a correctly formatted qa-*.check.md file.
 *
 * Usage (from QA agent via Bash):
 *   echo '<json>' | node workflows/check/scripts/write-qa-report.js
 *
 * Required JSON fields:
 *   - reportPath: string      — Full path to the output file (e.g. .../qa-status-site.check.md)
 *   - changesHash: string     — Git changes hash for cache-busting
 *   - appName: string         — App name (e.g. "status-site")
 *   - appUrl: string          — URL tested (e.g. "http://host.docker.internal:5175")
 *   - status: string          — "PASS" | "FAIL" | "INFRASTRUCTURE_FAILURE"
 *   - playwrightVerification: object — { toolsUsed: string[], externalConnectivity: object, appHealthCheck: object }
 *   - tests: array            — [{ name, status, details?, screenshot? }]
 *   - screenshots: array      — [{ path, description }]
 *
 * Optional fields:
 *   - summary: string         — Executive summary
 *   - mcpDiagnostics: string  — MCP diagnostics (required if INFRASTRUCTURE_FAILURE)
 *   - ticketId: string        — Jira ticket ID
 */

const { createReportWriter } = require('../../lib/scripts/write-report');

const ALLOWED_STATUSES = ['PASS', 'FAIL', 'INFRASTRUCTURE_FAILURE', 'ACCESS_FAILED', 'BLOCKED'];

const writer = createReportWriter({
  name: 'QA Report Writer',

  allowedAgents: ['qa-feature-tester', 'qa-api-tester'],

  requiredFields: [
    'reportPath',
    'changesHash',
    'appName',
    'appUrl',
    'status',
    'playwrightVerification',
    'tests',
    'screenshots',
  ],

  validate(input) {
    const errors = [];

    // Status must be valid
    if (!ALLOWED_STATUSES.includes(input.status)) {
      errors.push(
        `Invalid status "${input.status}". Must be one of: ${ALLOWED_STATUSES.join(', ')}`
      );
    }

    // Playwright verification structure
    const pv = input.playwrightVerification;
    if (pv) {
      if (!Array.isArray(pv.toolsUsed) || pv.toolsUsed.length === 0) {
        errors.push('playwrightVerification.toolsUsed must be a non-empty array of MCP tool names');
      }
      if (!pv.externalConnectivity) {
        errors.push('playwrightVerification.externalConnectivity is required (google.com check)');
      }
      if (!pv.appHealthCheck) {
        errors.push('playwrightVerification.appHealthCheck is required');
      }
    }

    // Tests array validation — each entry must be an object with string name/status
    if (Array.isArray(input.tests)) {
      for (let i = 0; i < input.tests.length; i++) {
        const t = input.tests[i];
        if (!t || typeof t !== 'object') {
          errors.push(`tests[${i}] must be a non-null object`);
          continue;
        }
        if (typeof t.name !== 'string' || !t.name)
          errors.push(`tests[${i}].name is required (string)`);
        if (typeof t.status !== 'string' || !t.status)
          errors.push(`tests[${i}].status is required (pass/fail/skip)`);
      }
    }

    // Screenshots: must have at least one (unless INFRASTRUCTURE_FAILURE)
    if (input.status !== 'INFRASTRUCTURE_FAILURE' && input.status !== 'ACCESS_FAILED' && input.status !== 'BLOCKED') {
      if (!Array.isArray(input.screenshots) || input.screenshots.length === 0) {
        errors.push('At least one screenshot is required for PASS/FAIL reports');
      }
    }

    // INFRASTRUCTURE_FAILURE / ACCESS_FAILED requires MCP diagnostics
    if ((input.status === 'INFRASTRUCTURE_FAILURE' || input.status === 'ACCESS_FAILED') && !input.mcpDiagnostics) {
      errors.push('mcpDiagnostics is required when status is INFRASTRUCTURE_FAILURE or ACCESS_FAILED');
    }

    // Report path must match qa-*.check.md pattern
    const basename = require('path').basename(input.reportPath || '');
    if (!/^qa-.*\.check\.md$/.test(basename)) {
      errors.push(`reportPath basename must match qa-*.check.md (got "${basename}")`);
    }

    return errors;
  },

  formatReport(input) {
    const lines = [];
    const timestamp = new Date().toISOString();

    // Header with changes hash (required for cache validation)
    // Status line for downstream gate compatibility (check-generate-summary.js)
    const gateStatus =
      input.status === 'PASS' ? 'APPROVED' : input.status === 'FAIL' ? 'NEEDS_WORK' : input.status;
    lines.push(`**Changes Hash:** ${input.changesHash}`);
    lines.push(`Status: ${gateStatus}`);
    lines.push('');
    lines.push(`# QA Report: ${input.appName}`);
    lines.push('');
    lines.push(`- **Date:** ${timestamp}`);
    lines.push(`- **App:** ${input.appName}`);
    lines.push(`- **URL:** ${input.appUrl}`);
    if (input.ticketId) lines.push(`- **Ticket:** ${input.ticketId}`);
    lines.push(`- **Status:** ${input.status}`);
    lines.push('');

    // Summary
    if (input.summary) {
      lines.push('## Summary');
      lines.push('');
      lines.push(input.summary);
      lines.push('');
    }

    // Playwright Connectivity Verification (EXACT format required by hooks)
    lines.push('## Playwright Connectivity Verification');
    lines.push('');

    const ec = input.playwrightVerification.externalConnectivity || {};
    lines.push('### External Connectivity (google.com)');
    lines.push(`- URL: ${ec.url || 'https://google.com'}`);
    lines.push(`- Status: ${ec.success ? '✅ SUCCESS' : '❌ FAILED'}`);
    lines.push(`- Evidence: ${ec.evidence || 'N/A'}`);
    lines.push('');

    const hc = input.playwrightVerification.appHealthCheck || {};
    lines.push('### App Health Check');
    lines.push(`- URL: ${hc.url || input.appUrl}`);
    lines.push(`- Status: ${hc.success ? '✅ SUCCESS' : '❌ FAILED'}`);
    lines.push(`- Evidence: ${hc.evidence || 'N/A'}`);
    lines.push('');

    // Playwright Verification (MCP tools used — EXACT format required by hooks)
    lines.push('## Playwright Verification');
    lines.push('');
    lines.push('### MCP Tools Used');
    const tools = input.playwrightVerification.toolsUsed || [];
    for (const tool of tools) {
      if (typeof tool === 'string') {
        lines.push(`- \`${tool}\` - Result: SUCCESS`);
      } else if (tool.name) {
        lines.push(
          `- \`${tool.name}\` - Result: ${tool.result || 'SUCCESS'}${tool.detail ? ' - ' + tool.detail : ''}`
        );
      }
    }
    lines.push('');

    // Test Results
    lines.push('## Test Results');
    lines.push('');

    const tests = input.tests || [];
    const passed = tests.filter((t) => t.status === 'pass').length;
    const failed = tests.filter((t) => t.status === 'fail').length;
    const skipped = tests.filter((t) => t.status === 'skip').length;

    lines.push(`| # | Test | Status | Details |`);
    lines.push(`|---|------|--------|---------|`);
    for (let i = 0; i < tests.length; i++) {
      const t = tests[i];
      const icon = t.status === 'pass' ? '✅' : t.status === 'fail' ? '❌' : '⏭️';
      lines.push(
        `| ${i + 1} | ${t.name} | ${icon} ${t.status.toUpperCase()} | ${t.details || ''} |`
      );
    }
    lines.push('');
    lines.push(
      `**Total:** ${passed} passed, ${failed} failed, ${skipped} skipped out of ${tests.length}`
    );
    lines.push('');

    // Screenshots
    lines.push('## Screenshots');
    lines.push('');
    const screenshots = input.screenshots || [];
    if (screenshots.length > 0) {
      lines.push('| File | Description |');
      lines.push('|------|-------------|');
      for (const ss of screenshots) {
        lines.push(`| ![](${ss.path}) | ${ss.description || ''} |`);
      }
    } else {
      lines.push('No screenshots captured (infrastructure failure).');
    }
    lines.push('');

    // MCP Diagnostics (for infrastructure failures)
    if (input.mcpDiagnostics) {
      lines.push('## MCP Diagnostics');
      lines.push('');
      lines.push(input.mcpDiagnostics);
      lines.push('');
    }

    // Final verdict
    lines.push('## Final Verdict');
    lines.push('');
    lines.push(
      `**${input.status}**${input.status === 'PASS' ? ' - All tests passed' : input.status === 'FAIL' ? ` - ${failed} test(s) failing` : ''}`
    );
    lines.push('');

    return lines.join('\n');
  },
});

writer.run().catch((err) => {
  process.stderr.write(`[QA Report Writer] Unexpected error: ${err.message}\n`);
  process.exit(1);
});
