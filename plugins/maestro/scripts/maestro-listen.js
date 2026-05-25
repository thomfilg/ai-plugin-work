#!/usr/bin/env node
// maestro-listen.js — tail -F /tmp/claude-agent-inbox/<CHANNEL>.log with a bell
//
// Usage: node maestro-listen.js <CHANNEL>
//
// Run inside a sidecar tmux session to get audible/visible alerts when
// another terminal writes to the channel.

'use strict';

const { spawn } = require('node:child_process');
const { validateChannelOrExit, ensureChannelFile } = require('../lib/inbox');

function main() {
  const [, , channel] = process.argv;
  validateChannelOrExit(channel, 'maestro-listen <CHANNEL>');
  const file = ensureChannelFile(channel);

  process.stdout.write(`listening on ${file}\n`);

  const tail = spawn('tail', ['-n', '0', '-F', file]);
  tail.stdout.on('data', (chunk) => {
    const lines = chunk.toString('utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      process.stdout.write(`\x07>>> ${line}\n`);
    }
  });
  tail.stderr.on('data', (chunk) => process.stderr.write(chunk));
  tail.on('exit', (code) => process.exit(code ?? 0));
}

main();
