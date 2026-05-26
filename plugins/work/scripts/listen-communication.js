#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const INBOX_DIR = process.env.CLAUDE_AGENT_INBOX_DIR || '/tmp/claude-agent-inbox';

function usage(code) {
  process.stderr.write(
    'usage: listen-communication.js <ticket-id>\n' +
      '  Tails /tmp/claude-agent-inbox/<TICKET>.log and prints new messages.\n' +
      '  Beeps (bell char) on each new line so a tmux pane gets activity highlight.\n'
  );
  process.exit(code);
}

const [, , rawTicket] = process.argv;
if (!rawTicket) usage(1);

const ticket = rawTicket.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
if (!ticket) {
  process.stderr.write(`invalid ticket id: ${rawTicket}\n`);
  process.exit(1);
}

fs.mkdirSync(INBOX_DIR, { recursive: true, mode: 0o755 });
const inbox = path.join(INBOX_DIR, `${ticket}.log`);
if (!fs.existsSync(inbox)) fs.closeSync(fs.openSync(inbox, 'a'));

process.stdout.write(`listening on ${inbox} (Ctrl-C to stop)\n`);

const tail = spawn('tail', ['-n', '0', '-F', inbox], { stdio: ['ignore', 'pipe', 'inherit'] });

const DONE_SENTINEL = '__MONITOR_DONE__';

let buf = '';
tail.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.length === 0) continue;
    process.stdout.write(`\x07>>> ${line}\n`);
    if (line.includes(DONE_SENTINEL)) {
      process.stdout.write(`[${ticket}] channel marked complete — listener exiting.\n`);
      try {
        tail.kill('SIGTERM');
      } catch {}
      process.exit(0);
    }
  }
});

tail.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => tail.kill('SIGINT'));
process.on('SIGTERM', () => tail.kill('SIGTERM'));
