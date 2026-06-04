#!/usr/bin/env node
'use strict';

/**
 * Smoke-test what would fire for a given event payload.
 *
 *   node synapsys-test.js --event=UserPromptSubmit --prompt='<text>'
 *   node synapsys-test.js --event=PreToolUse --tool=Bash --input='{"command":"git push"}'
 *   node synapsys-test.js --event=SessionStart
 *   node synapsys-test.js [...] --cwd=<path>
 *
 * Reuses the dispatcher hook by piping a synthetic payload to it.
 * Prints what the hook would emit; exit 0 even on no-match.
 */

const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeFlag } = require(path.join(__dirname, '..', 'lib', 'cli-args'));

const flag = makeFlag(process.argv.slice(2));

const event = flag('event') || 'UserPromptSubmit';
const cwd = flag('cwd') || process.cwd();
const prompt = flag('prompt');
const tool = flag('tool');
const input = flag('input');

const payload = { cwd };
if (event === 'UserPromptSubmit') {
  payload.prompt = prompt || '';
} else if (event === 'PreToolUse') {
  payload.tool_name = tool || 'Bash';
  try {
    payload.tool_input = input ? JSON.parse(input) : {};
  } catch {
    payload.tool_input = { command: input || '' };
  }
}

const dispatcher = path.join(__dirname, '..', 'hooks', 'synapsys.js');
const result = spawnSync('node', [dispatcher, event], {
  input: JSON.stringify(payload),
  encoding: 'utf8',
});

if (result.stdout && result.stdout.length) {
  process.stdout.write(result.stdout);
} else {
  console.log(`(no memories matched for event=${event})`);
}
if (result.stderr && result.stderr.length) process.stderr.write(result.stderr);
process.exit(0);
