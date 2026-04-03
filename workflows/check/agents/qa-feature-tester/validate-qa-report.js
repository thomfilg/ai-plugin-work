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

    // Check: Evidence of Playwright MCP usage
    const hasPlaywrightMCP = content.includes('mcp__playwright__') ||
                             content.includes('mcp__playwright_headed__');

    if (!hasPlaywrightMCP && !content.includes('INFRASTRUCTURE_FAILURE')) {
      issues.push('No evidence of Playwright MCP tool usage');
    }

    // Check: If INFRASTRUCTURE_FAILURE, must have MCP diagnostics
    if (content.includes('INFRASTRUCTURE_FAILURE')) {
      if (!content.includes('## MCP Diagnostics') && !content.includes('ListMcpResourcesTool')) {
        issues.push('INFRASTRUCTURE_FAILURE report missing MCP diagnostics');
      }
    }

    // Check: Screenshot references
    const hasScreenshots = content.match(/!\[.*?\]\(.*?\.(png|jpg|jpeg)/i) ||
                          content.includes('screenshots/');

    if (!hasScreenshots && !content.includes('INFRASTRUCTURE_FAILURE')) {
      issues.push('No screenshot references found');
    }

    // Check: Has test results
    if (!content.includes('PASS') && !content.includes('FAIL') && !content.includes('INFRASTRUCTURE_FAILURE')) {
      issues.push('Missing test status (PASS/FAIL)');
    }
  }

  if (issues.length > 0) {
    process.stderr.write(`QA Report Validation FAILED\n\n${issues.map((i, n) => `${n + 1}. ${i}`).join('\n')}\n`);
    process.exit(2);
  }

  process.exit(0);
}

main().catch(() => {
  process.exit(0);
});
