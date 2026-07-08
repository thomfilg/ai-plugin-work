#!/usr/bin/env node
/**
 * Stop hook: Remove marker file when QA agent stops
 * (Only runs in qa-feature-tester context - no detection needed)
 */
const fs = require('fs');
const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', '..', 'lib', 'hook-error-log'));

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  // Remove marker file
  try {
    fs.unlinkSync('/tmp/qa-agent-active');
  } catch {
    /* file may not exist */
  }

  console.log(JSON.stringify({}));
}

main().catch((err) => {
  logHookError(__filename, err);
  console.log(JSON.stringify({}));
});
