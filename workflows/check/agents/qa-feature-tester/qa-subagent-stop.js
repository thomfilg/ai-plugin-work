#!/usr/bin/env node
/**
 * Stop hook: Remove marker file when QA agent stops
 * (Only runs in qa-feature-tester context - no detection needed)
 */
const fs = require('fs');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  // Remove marker file
  try {
    fs.unlinkSync('/tmp/qa-agent-active');
  } catch { /* file may not exist */ }

  console.log(JSON.stringify({}));
}

main().catch(() => {
  console.log(JSON.stringify({}));
});
