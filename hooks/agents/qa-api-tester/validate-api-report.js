#!/usr/bin/env node
/**
 * Stop Hook: API QA Report Validator
 * (Only runs in qa-api-tester context)
 *
 * Requirements:
 * 1. Report file (qa-api.md) must exist
 * 2. Must have "## API Connectivity Verification" section
 * 3. Must have evidence of curl or database query usage
 * 4. Must have test results (PASS/FAIL)
 * 5. HTTP file (qa-api.http) must exist with requests
 */

const fs = require('fs');
const path = require('path');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  // Find the most recent qa-api report
  let _config;
  try { _config = require(path.join(__dirname, '..', '..', '..', 'lib', 'config')); } catch { _config = null; }
  const tasksDir = _config?.TASKS_BASE || `${process.env.HOME}/worktrees/tasks`;
  let reportPath = null;
  let reportContent = null;
  let httpPath = null;
  let httpContent = null;
  let taskDir = null;

  try {
    const dirs = fs.readdirSync(tasksDir).filter(d => {
      const stat = fs.statSync(path.join(tasksDir, d));
      return stat.isDirectory();
    });

    // Look for qa-api.md in task directories (sorted by modification time, newest first)
    const dirsWithTime = dirs.map(d => ({
      name: d,
      mtime: fs.statSync(path.join(tasksDir, d)).mtime.getTime()
    })).sort((a, b) => b.mtime - a.mtime);

    for (const dir of dirsWithTime) {
      const qaPath = path.join(tasksDir, dir.name, 'qa-api.md');
      if (fs.existsSync(qaPath)) {
        reportPath = qaPath;
        reportContent = fs.readFileSync(qaPath, 'utf8');
        taskDir = dir.name;

        // Also check for .http file
        const httpFilePath = path.join(tasksDir, dir.name, 'qa-api.http');
        if (fs.existsSync(httpFilePath)) {
          httpPath = httpFilePath;
          httpContent = fs.readFileSync(httpFilePath, 'utf8');
        }
        break;
      }
    }
  } catch (e) {
    // Can't find report directory - allow completion
    process.exit(0);
  }

  if (!reportPath || !reportContent) {
    // No report found - this might be okay if report wasn't created yet
    process.exit(0);
  }

  const issues = [];

  // Check: API Connectivity Verification section
  if (!reportContent.includes('## API Connectivity Verification') &&
      !reportContent.includes('### Service Health Check')) {
    issues.push('Missing "## API Connectivity Verification" section');
  }

  // Check: Evidence of curl usage or database query
  const hasCurl = reportContent.includes('curl ') || reportContent.includes('curl -');
  const hasDbQuery = reportContent.includes('mcp__pg_') ||
                     reportContent.includes('SELECT ') ||
                     reportContent.includes('INSERT ') ||
                     reportContent.includes('UPDATE ') ||
                     reportContent.includes('DELETE ');

  if (!hasCurl && !hasDbQuery) {
    issues.push('No evidence of API testing (curl) or database verification');
  }

  // Check: Has test results
  if (!reportContent.includes('PASS') && !reportContent.includes('FAIL') && !reportContent.includes('BLOCKED')) {
    issues.push('Missing test status (PASS/FAIL/BLOCKED)');
  }

  // Check: Has summary section
  if (!reportContent.includes('## Summary') && !reportContent.includes('### Summary')) {
    issues.push('Missing test summary section');
  }

  // Check: .http file exists
  if (!httpPath || !httpContent) {
    issues.push(`Missing qa-api.http file in ${taskDir || 'task directory'}`);
  } else {
    // Validate .http file content
    const httpIssues = validateHttpFile(httpContent);
    issues.push(...httpIssues);
  }

  if (issues.length > 0) {
    process.stderr.write(`API QA Report Validation Issues:\n\n${issues.map((i, n) => `${n + 1}. ${i}`).join('\n')}\n\nReport: ${reportPath}${httpPath ? `\nHTTP File: ${httpPath}` : ''}\n`);
    process.exit(2);
  }

  process.exit(0);
}

/**
 * Validate .http file content
 */
function validateHttpFile(content) {
  const issues = [];

  // Check: Has at least one request separator
  if (!content.includes('###')) {
    issues.push('.http file missing request separators (###)');
  }

  // Check: Has at least one HTTP method
  const hasHttpMethod = /^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+http/m.test(content);
  if (!hasHttpMethod) {
    issues.push('.http file missing HTTP requests (GET/POST/PUT/DELETE)');
  }

  // Check: Has base URL or direct URLs
  const hasBaseUrl = content.includes('@baseUrl') || content.includes('http://') || content.includes('https://');
  if (!hasBaseUrl) {
    issues.push('.http file missing URLs');
  }

  // Check: Has status comments (evidence of actual testing)
  const hasStatusComments = /# Status:\s*(PASS|FAIL|BLOCKED)/i.test(content);
  if (!hasStatusComments) {
    issues.push('.http file missing "# Status: PASS/FAIL" comments - update with test results');
  }

  // Warning check: Secrets potentially exposed (non-blocking, just warn)
  const hasPotentialSecrets = /(Authorization|X-API-Key|Cookie):\s*[^<\n]+[^REDACTED\n]/i.test(content);
  if (hasPotentialSecrets) {
    // This is a warning, not a blocking issue - just check it's not obviously a real token
    const hasRealToken = /Authorization:\s*Bearer\s+ey[A-Za-z0-9]/i.test(content);
    if (hasRealToken) {
      issues.push('.http file may contain exposed secrets - redact Authorization headers');
    }
  }

  return issues;
}

main().catch(() => {
  process.exit(0);
});
