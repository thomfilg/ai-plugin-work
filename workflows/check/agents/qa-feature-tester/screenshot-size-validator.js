#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

/**
 * PostToolUse hook: Validates screenshot file sizes after capture.
 *
 * Warning band: 150-200KB — warns but keeps the file (UI-dense pages may be legit).
 * Delete threshold: >200KB — auto-deletes as likely full-page capture.
 * Element-focused screenshots should be 20-100KB.
 */

const WARN_SIZE_KB = 150;
const DELETE_SIZE_KB = 200;

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let hookData;
  try {
    hookData = JSON.parse(input);
  } catch {
    console.log(JSON.stringify({}));
    return;
  }

  const toolName = hookData.tool_name || '';

  // Only check screenshot tools
  if (!toolName.includes('browser_take_screenshot')) {
    console.log(JSON.stringify({}));
    return;
  }

  const toolInput = hookData.tool_input || {};
  const filename = toolInput.filename || '';

  if (!filename) {
    console.log(JSON.stringify({}));
    return;
  }

  // Check if file exists and get size
  try {
    if (!fs.existsSync(filename)) {
      console.log(JSON.stringify({}));
      return;
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
      console.log(JSON.stringify({ message }));
      return;
    } else if (sizeKB > WARN_SIZE_KB) {
      // Warn but keep — UI-dense pages can produce legit large element screenshots
      const message = [
        '',
        `Screenshot ${path.basename(filename)} is ${sizeKB}KB (recommended: <${WARN_SIZE_KB}KB).`,
        'Consider using ref parameter for tighter element focus.',
        '',
      ].join('\n');
      console.log(JSON.stringify({ message }));
      return;
    }
  } catch {
    // File access error, don't block
  }

  console.log(JSON.stringify({}));
}

main().catch(() => {
  console.log(JSON.stringify({}));
});
