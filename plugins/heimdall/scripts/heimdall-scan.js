#!/usr/bin/env node
'use strict';

/**
 * Scan for protectable paths and emit suggestions for the install flow.
 *
 *   node heimdall-scan.js --kind=<local|worktree|global|shared> [--cwd=<path>] [--json]
 *
 * Thin CLI wrapper around lib/scan.js (the logic lives there so it is unit-
 * testable in-process). Output is JSON with --json, else human-readable.
 */

const path = require('node:path');
const { parseArgs } = require(path.join(__dirname, '..', 'lib', 'cli'));
const { scan } = require(path.join(__dirname, '..', 'lib', 'scan'));

const args = parseArgs(process.argv);
const suggestions = scan({ cwd: args.cwd, kind: args.kind || 'local' });

if (args.json) {
  console.log(JSON.stringify(suggestions, null, 2));
  process.exit(0);
}

if (suggestions.length === 0) {
  console.log('No new protectable paths detected for this install.');
  process.exit(0);
}

console.log(`Detected ${suggestions.length} protectable path group(s):\n`);
for (const s of suggestions) {
  console.log(`• ${s.label} — ${s.description}`);
  console.log(`    paths:  ${s.protect.join(', ')}`);
  console.log(`    phrase: "${s.defaultPhrase}"`);
}
