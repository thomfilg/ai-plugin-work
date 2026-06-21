#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { runJsonHook } = require(path.join(__dirname, '..', '..', '..', 'lib', 'hook-error-log'));

/**
 * PostToolUse hook: Validates screenshot file sizes after capture.
 *
 * Warning band: 150-200KB — warns but keeps the file (UI-dense pages may be legit).
 * Delete threshold: >200KB — auto-deletes as likely full-page capture.
 * Element-focused screenshots should be 20-100KB.
 */

const WARN_SIZE_KB = 150;
const DELETE_SIZE_KB = 200;

/**
 * Parse stdin JSON and extract the screenshot filename to validate.
 * Returns the filename, or '' when this invocation should be a no-op
 * (non-screenshot tool, missing filename, or malformed input).
 */
function resolveScreenshotFilename(input) {
  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    return '';
  }

  const toolName = hookData.tool_name || '';
  if (!toolName.includes('browser_take_screenshot')) {
    return '';
  }

  const toolInput = hookData.tool_input || {};
  return toolInput.filename || '';
}

/**
 * Inspect a screenshot file and return the hook response payload.
 * Auto-deletes oversized captures and returns the appropriate message;
 * returns `{}` when the file is within limits, missing, or unreadable.
 */
function evaluateScreenshot(filename) {
  try {
    if (!fs.existsSync(filename)) {
      return {};
    }

    const stats = fs.statSync(filename);
    // Use Math.ceil to ensure slightly-oversized files aren't rounded down past thresholds
    const sizeKB = Math.ceil(stats.size / 1024);
    if (sizeKB > DELETE_SIZE_KB) {
      // Auto-delete — almost certainly a full-page capture
      fs.unlinkSync(filename);
      const message = [
        '',
        'SCREENSHOT SIZE VALIDATION FAILED',
        '─'.repeat(50),
        `  File: ${path.basename(filename)}`,
        `  Size: ${sizeKB}KB (max: ${DELETE_SIZE_KB}KB)`,
        '',
        'This is likely a full-page screenshot. You MUST:',
        '  1. Call browser_snapshot to get element refs',
        '  2. Re-take using ref parameter to focus on the specific element',
        '  3. Element screenshots should be 20-100KB',
        '─'.repeat(50),
      ].join('\n');
      return { message };
    }
    if (sizeKB > WARN_SIZE_KB) {
      // Warn but keep — UI-dense pages can produce legit large element screenshots
      const message = [
        '',
        `Screenshot ${path.basename(filename)} is ${sizeKB}KB (recommended: <${WARN_SIZE_KB}KB).`,
        'Consider using ref parameter for tighter element focus.',
        '',
      ].join('\n');
      return { message };
    }
  } catch {
    // File access error, don't block
  }

  return {};
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const filename = resolveScreenshotFilename(input);
  if (!filename) {
    console.log(JSON.stringify({}));
    return;
  }

  console.log(JSON.stringify(evaluateScreenshot(filename)));
}

runJsonHook(__filename, main);
