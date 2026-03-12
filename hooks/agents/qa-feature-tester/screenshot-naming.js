#!/usr/bin/env node

const fs = require('fs');

/**
 * PreToolUse hook to enforce screenshot naming conventions for QA testing.
 *
 * Validates that screenshots follow the pattern: {N}-{scenario}-{state}.png
 * and are saved to the proper tasks directory.
 */

// function logExecution(data) {
//   const logFile = '/tmp/screenshot-naming.txt';
//   const timestamp = new Date().toISOString();
//   const logEntry = `[${timestamp}] ${JSON.stringify(data)}\n`;
//   fs.appendFileSync(logFile, logEntry);
// }

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    // logExecution({ event: 'parse_error', input: input.substring(0, 200) });
    process.exit(0);
  }

  const toolName = hookData.tool_name || '';
  const toolInput = hookData.tool_input || {};

  // Log disabled - uncomment logExecution function and this to debug
  // logExecution({
  //   event: 'hook_called',
  //   tool: toolName,
  //   filename: toolInput.filename || 'none'
  // });

  // Only check screenshot tools
  if (!toolName.includes('browser_take_screenshot')) {
    process.exit(0);
  }

  const filename = toolInput.filename || '';

  // If no filename provided, just approve (Playwright will auto-generate)
  if (!filename) {
    process.exit(0);
  }

  // Check if it's a QA task screenshot (in global tasks directory)
  let _config;
  try { _config = require(require('path').join(__dirname, '..', '..', '..', 'lib', 'config')); } catch { _config = null; }
  const tasksBase = _config?.TASKS_BASE || `${process.env.HOME}/worktrees/tasks`;
  const isTaskScreenshot = filename.includes(tasksBase + '/') && filename.includes('screenshots/');

  if (!isTaskScreenshot) {
    // Not a task screenshot, approve without validation
    process.exit(0);
  }

  // Extract just the filename from the path
  const basename = filename.split('/').pop();

  // Validate naming pattern: {N}-{scenario}-{state}.png
  // Pattern: starts with number, followed by dash, then scenario-state, ends with .png
  const validPattern = /^\d+-[a-z0-9]+-[a-z0-9-]+\.(png|jpeg)$/i;

  if (!validPattern.test(basename)) {
    process.stderr.write(
      `Screenshot naming violation!\n\n` +
      `Expected format: {N}-{scenario}-{state}.png\n` +
      `Got: ${basename}\n\n` +
      `Examples:\n` +
      `  OK: 1-impersonate-role-menu.png\n` +
      `  OK: 2-impersonate-role-modal-empty.png\n` +
      `  OK: 3-login-form-filled.png\n\n` +
      `  BAD: screenshot.png\n` +
      `  BAD: modal.png\n` +
      `  BAD: impersonate-role.png (missing number prefix)\n\n` +
      `Fix the filename to follow the convention.\n`
    );
    process.exit(2);
  }

  // Validate number prefix is reasonable (1-99)
  const numberPrefix = parseInt(basename.split('-')[0], 10);
  if (numberPrefix < 1 || numberPrefix > 99) {
    process.stderr.write(`Screenshot number prefix out of range: ${numberPrefix}\nExpected: 1-99\nFix the filename to use a valid step number.\n`);
    process.exit(2);
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Hook error:', err.message);
  process.exit(0);
});
