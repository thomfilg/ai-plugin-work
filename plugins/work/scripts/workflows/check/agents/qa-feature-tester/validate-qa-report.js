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

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const data = JSON.parse(input);
  const prompt = data.task_prompt || data.prompt || '';

  // Extract report path from the prompt
  const reportPathMatch = prompt.match(/REPORT_PATH:\s*([^\n\s]+)/);
  if (!reportPathMatch) {
    // Can't determine report path - allow completion
    process.exit(0);
  }

  const reportPath = reportPathMatch[1].trim();
  const issues = [];

  if (!fs.existsSync(reportPath)) {
    issues.push(`Report file not created: ${reportPath}`);
  } else {
    const content = fs.readFileSync(reportPath, 'utf8');

    // Check: Playwright Verification section
    if (!content.includes('## Playwright Verification')) {
      issues.push('Missing "## Playwright Verification" section');
    }

    // Check: Evidence of browser MCP usage — require tool name and "Result:" on the same line,
    // allowing common separators like whitespace, colon, or dash variants
    const browserToolPattern =
      /`?mcp__(playwright|claude-in-chrome)__\w+`?\s*(?:[-–—:]?\s*)Result:\s*(SUCCESS|FAIL)/i;
    const hasBrowserMCP = browserToolPattern.test(content);

    if (
      !hasBrowserMCP &&
      !content.includes('INFRASTRUCTURE_FAILURE') &&
      !content.includes('ACCESS_FAILED')
    ) {
      issues.push(
        'No structured browser tool evidence — expected `mcp__playwright__...` or `mcp__claude-in-chrome__...` tool calls, each with "Result: SUCCESS" or "Result: FAIL"'
      );
    }

    // Check: If INFRASTRUCTURE_FAILURE or ACCESS_FAILED, must have MCP diagnostics
    if (content.includes('INFRASTRUCTURE_FAILURE') || content.includes('ACCESS_FAILED')) {
      if (!content.includes('## MCP Diagnostics') && !content.includes('ListMcpResourcesTool')) {
        issues.push('INFRASTRUCTURE_FAILURE/ACCESS_FAILED report missing MCP diagnostics');
      }
    }

    // Check: Screenshot references
    const hasScreenshots =
      content.match(/!\[.*?\]\(.*?\.(png|jpg|jpeg)/i) || content.includes('screenshots/');

    if (
      !hasScreenshots &&
      !content.includes('INFRASTRUCTURE_FAILURE') &&
      !content.includes('ACCESS_FAILED')
    ) {
      issues.push('No screenshot references found');
    }

    // Check: Has structured test results (in table rows or after "Status:" labels)
    // Matches canonical statuses (APPROVED/NEEDS_WORK) alongside legacy ones (PASS/FAIL)
    const hasTestStatus =
      /\|\s*(PASS|FAIL|APPROVED|NEEDS_WORK)\s*\|/i.test(content) ||
      /Status:\s*(PASS|FAIL|APPROVED|NEEDS_WORK)/i.test(content) ||
      content.includes('INFRASTRUCTURE_FAILURE') ||
      content.includes('ACCESS_FAILED');
    if (!hasTestStatus) {
      issues.push(
        'Missing test status — PASS/FAIL must appear in a results table or after "Status:"'
      );
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
