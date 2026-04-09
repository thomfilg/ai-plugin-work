#!/usr/bin/env node

const fs = require('fs');

/**
 * PostToolUse hook: Tracks the last URL navigated to by browser_navigate.
 * Writes to /tmp/qa-last-navigated-url so the snapshot validator can
 * key retry state by actual page URL instead of 'unknown'.
 */

const URL_FILE = '/tmp/qa-last-navigated-url';

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

  const toolInput = hookData.tool_input || {};
  const url = toolInput.url || '';

  if (url) {
    fs.writeFileSync(URL_FILE, url);
  }

  console.log(JSON.stringify({}));
}

main().catch(() => {
  console.log(JSON.stringify({}));
});
