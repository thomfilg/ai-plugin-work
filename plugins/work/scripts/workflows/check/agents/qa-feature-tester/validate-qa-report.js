#!/usr/bin/env node
/**
 * Stop Hook: QA Report Validator
 * (Only runs in qa-feature-tester context - no detection needed)
 *
 * Requirements:
 * 1. Report file must exist
 * 2. Must have "## Playwright Verification" section
 * 3. Must have evidence of Playwright MCP usage
 * 4. Must have at least one screenshot reference
 */

const fs = require('fs');
const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', '..', 'lib', 'hook-error-log'));

/** Read the hook payload and extract the REPORT_PATH from the task prompt. */
async function readReportPathFromStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const data = JSON.parse(chunks.join(''));
  const prompt = data.task_prompt || data.prompt || '';
  const reportPathMatch = prompt.match(/REPORT_PATH:\s*([^\n\s]+)/);
  return reportPathMatch ? reportPathMatch[1].trim() : null;
}

function hasInfraMarkers(content) {
  return content.includes('INFRASTRUCTURE_FAILURE') || content.includes('ACCESS_FAILED');
}

/**
 * Check: Evidence of browser MCP usage — require tool name and "Result:" on
 * the same line, allowing common separators like whitespace, colon, or dash
 * variants.
 */
function checkBrowserEvidence(content, issues) {
  const browserToolPattern =
    /`?mcp__(playwright|claude-in-chrome)__\w+`?\s*(?:[-–—:]?\s*)Result:\s*(SUCCESS|FAIL)/i;
  if (!browserToolPattern.test(content) && !hasInfraMarkers(content)) {
    issues.push(
      'No structured browser tool evidence — expected `mcp__playwright__...` or `mcp__claude-in-chrome__...` tool calls, each with "Result: SUCCESS" or "Result: FAIL"'
    );
  }
}

/** Check: If INFRASTRUCTURE_FAILURE or ACCESS_FAILED, must have MCP diagnostics. */
function checkFailureDiagnostics(content, issues) {
  if (!hasInfraMarkers(content)) return;
  if (!content.includes('## MCP Diagnostics') && !content.includes('ListMcpResourcesTool')) {
    issues.push('INFRASTRUCTURE_FAILURE/ACCESS_FAILED report missing MCP diagnostics');
  }
}

/** Check: Screenshot references. */
function checkScreenshots(content, issues) {
  const hasScreenshots =
    content.match(/!\[.*?\]\(.*?\.(png|jpg|jpeg)/i) || content.includes('screenshots/');
  if (!hasScreenshots && !hasInfraMarkers(content)) {
    issues.push('No screenshot references found');
  }
}

/**
 * Check: Has structured test results (in table rows or after "Status:" labels).
 * Matches canonical statuses (APPROVED/NEEDS_WORK) alongside legacy ones (PASS/FAIL).
 */
function checkTestStatus(content, issues) {
  const hasTestStatus =
    /\|\s*(PASS|FAIL|APPROVED|NEEDS_WORK)\s*\|/i.test(content) ||
    /Status:\s*(PASS|FAIL|APPROVED|NEEDS_WORK)/i.test(content) ||
    hasInfraMarkers(content);
  if (!hasTestStatus) {
    issues.push(
      'Missing test status — PASS/FAIL must appear in a results table or after "Status:"'
    );
  }
}

/**
 * Validate the report content. Returns null when validation must be skipped
 * entirely (MCP-disconnect BLOCKED reports), otherwise the list of issues.
 */
function collectReportIssues(content) {
  // MCP-disconnect BLOCKED reports (echo-5528-issue-003): no browser tool ever
  // ran, so Playwright evidence/screenshots cannot exist. Require only the
  // actionable remediation line and pass through.
  const mcpBlocked = /BLOCKED:\s*.*MCP not connected/i.test(content) && content.includes('/mcp');
  if (mcpBlocked) return null;

  const issues = [];
  // Check: Playwright Verification section
  if (!content.includes('## Playwright Verification')) {
    issues.push('Missing "## Playwright Verification" section');
  }
  checkBrowserEvidence(content, issues);
  checkFailureDiagnostics(content, issues);
  checkScreenshots(content, issues);
  checkTestStatus(content, issues);
  return issues;
}

async function main() {
  const reportPath = await readReportPathFromStdin();
  if (!reportPath) {
    // Can't determine report path - allow completion
    process.exit(0);
  }

  let issues = [];
  if (!fs.existsSync(reportPath)) {
    issues.push(`Report file not created: ${reportPath}`);
  } else {
    issues = collectReportIssues(fs.readFileSync(reportPath, 'utf8'));
    if (issues === null) {
      process.exit(0);
    }
  }

  if (issues.length > 0) {
    process.stderr.write(
      `QA Report Validation FAILED\n\n${issues.map((i, n) => `${n + 1}. ${i}`).join('\n')}\n`
    );
    process.exit(2);
  }

  process.exit(0);
}

main().catch((err) => {
  logHookError(__filename, err);
  process.exit(0);
});
