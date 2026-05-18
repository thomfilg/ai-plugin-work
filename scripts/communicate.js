#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INBOX_DIR = process.env.CLAUDE_AGENT_INBOX_DIR || '/tmp/claude-agent-inbox';

function usage(code) {
  process.stderr.write(
    'usage: communicate.js <ticket-id> <message...>\n' +
      '       communicate.js --check <ticket-id>\n' +
      '       communicate.js --watch <ticket-id>\n' +
      '  ticket-id is case-insensitive (echo-1234 → ECHO-1234)\n' +
      '  message can be a single quoted string or remaining argv joined with spaces\n' +
      '  --check prints listener PIDs for the channel (no send)\n' +
      '  --watch polls every 1s and prints listener join/leave events\n' +
      '  Send always reports listener count; exits 3 if zero listeners.\n'
  );
  process.exit(code);
}

function findListeners(inboxPath) {
  let target;
  try {
    target = fs.realpathSync(inboxPath);
  } catch {
    return [];
  }
  const pids = [];
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return [];
  }
  for (const pid of entries) {
    if (!/^\d+$/.test(pid)) continue;
    const fdDir = `/proc/${pid}/fd`;
    let fds;
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      try {
        const link = fs.readlinkSync(`${fdDir}/${fd}`);
        if (link === target || link === inboxPath) {
          pids.push(Number(pid));
          break;
        }
      } catch {}
    }
  }
  return pids.filter((p) => p !== process.pid);
}

const args = process.argv.slice(2);
const checkOnly = args[0] === '--check' || args[0] === '-c';
const watchMode = args[0] === '--watch' || args[0] === '-w';
if (checkOnly || watchMode) args.shift();

const [rawTicket, ...rest] = args;
if (!rawTicket) usage(1);
if (!checkOnly && !watchMode && rest.length === 0) usage(1);

const ticket = rawTicket.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
if (!ticket) {
  process.stderr.write(`invalid ticket id: ${rawTicket}\n`);
  process.exit(1);
}

fs.mkdirSync(INBOX_DIR, { recursive: true, mode: 0o755 });
const inbox = path.join(INBOX_DIR, `${ticket}.log`);

if (checkOnly) {
  if (!fs.existsSync(inbox)) {
    process.stdout.write(`no inbox file yet: ${inbox} (0 listeners)\n`);
    process.exit(3);
  }
  const listeners = findListeners(inbox);
  process.stdout.write(
    `${inbox}: ${listeners.length} listener(s)${listeners.length ? ` — pids: ${listeners.join(', ')}` : ''}\n`
  );
  process.exit(listeners.length === 0 ? 3 : 0);
}

if (watchMode) {
  if (!fs.existsSync(inbox)) fs.closeSync(fs.openSync(inbox, 'a'));
  let prev = new Set(findListeners(inbox));
  process.stdout.write(
    `watching ${inbox} for listener changes (Ctrl-C to stop)\n` +
      `\x07initial: ${prev.size} listener(s)${prev.size ? ` — pids: ${[...prev].join(', ')}` : ''}\n`
  );
  const tick = () => {
    const now = new Set(findListeners(inbox));
    const joined = [...now].filter((p) => !prev.has(p));
    const left = [...prev].filter((p) => !now.has(p));
    const ts = new Date().toISOString();
    for (const p of joined)
      process.stdout.write(`\x07[${ts}] + listener joined pid=${p} (total=${now.size})\n`);
    for (const p of left)
      process.stdout.write(`\x07[${ts}] - listener left   pid=${p} (total=${now.size})\n`);
    prev = now;
  };
  const interval = setInterval(tick, 1000);
  const stop = () => {
    clearInterval(interval);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
} else {
  // Send mode — wrapped in else so watch mode does NOT fall through into
  // this block (which would write an empty timestamped line and exit(3),
  // killing the watch interval set up above).
  if (!fs.existsSync(inbox)) fs.closeSync(fs.openSync(inbox, 'a'));
  const listenersBefore = findListeners(inbox);

  const message = rest.join(' ');
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}\n`;
  fs.appendFileSync(inbox, line, { mode: 0o644 });

  process.stdout.write(
    `sent → ${inbox} (${listenersBefore.length} listener(s)${listenersBefore.length ? `, pids: ${listenersBefore.join(', ')}` : ''})\n${line}`
  );
  if (listenersBefore.length === 0) {
    process.stderr.write(
      'warning: no active listeners detected — message written but no one is tailing.\n'
    );
    process.exit(3);
  }
}
