#!/usr/bin/env node
// maestro-listen.js — tail -F /tmp/claude-agent-inbox/<CHANNEL>.log with a bell
//
// Usage: node maestro-listen.js <CHANNEL>
//
// Run inside a sidecar tmux session to get audible/visible alerts when
// another terminal writes to the channel.

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const INBOX_DIR = '/tmp/claude-agent-inbox';

function main() {
  const [, , channel] = process.argv;
  if (!channel) {
    console.error('usage: maestro-listen <CHANNEL>');
    process.exit(2);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(channel)) {
    console.error(`invalid channel name: ${channel}`);
    process.exit(2);
  }
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const file = path.join(INBOX_DIR, `${channel}.log`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');

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
