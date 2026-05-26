#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const INBOX_DIR = process.env.CLAUDE_AGENT_INBOX_DIR || '/tmp/claude-agent-inbox';

const { TICKET_PREFIX_RE, DONE_SENTINEL, WELCOME_MESSAGE } = require('./monitor-manager');

// CLI: positional filter still works (e.g. `listen-all.js MONITOR`).
// Optional flags:
//   --manage           Run workflow-manager logic on the MONITOR channel
//                      (auto-welcome on first contact, mark completion on
//                      __MONITOR_DONE__ lines). Off by default for
//                      back-compat.
//   --archive          With --manage, archive completed channel logs into
//                      <INBOX_DIR>/archived/.
const args = process.argv.slice(2);
let filter = null;
let manageMode = false;
let archiveMode = false;
for (const a of args) {
  if (a === '--manage') manageMode = true;
  else if (a === '--archive') archiveMode = true;
  else if (a === '-h' || a === '--help') {
    process.stderr.write(
      'usage: listen-all.js [FILTER] [--manage] [--archive]\n' +
        '  FILTER: substring of channel name (case-insensitive)\n' +
        '  --manage: on MONITOR channel, auto-welcome new tickets +\n' +
        '            mark completion on __MONITOR_DONE__ sentinels\n' +
        '  --archive: with --manage, move completed channels to\n' +
        '             <INBOX_DIR>/archived/\n'
    );
    process.exit(0);
  } else if (!filter && !a.startsWith('-')) {
    filter = a;
  } else {
    process.stderr.write(`unknown arg: ${a}\n`);
    process.exit(1);
  }
}

fs.mkdirSync(INBOX_DIR, { recursive: true, mode: 0o755 });

function matchesFilter(name) {
  if (!name.endsWith('.log')) return false;
  if (filter && !name.toUpperCase().includes(filter.toUpperCase())) return false;
  return true;
}

// ─── manager state (used only when --manage and channel is MONITOR) ──────
const welcomed = new Set();
const completed = new Set();

function extractTicket(line) {
  const m = line.match(TICKET_PREFIX_RE);
  return m ? m[1].toUpperCase() : null;
}

function sendTo(ticket, text) {
  const inbox = path.join(INBOX_DIR, `${ticket}.log`);
  if (!fs.existsSync(inbox)) fs.closeSync(fs.openSync(inbox, 'a'));
  const ts = new Date().toISOString();
  fs.appendFileSync(inbox, `[${ts}] MONITOR: ${text}\n`, { mode: 0o644 });
}

function archiveChannel(ticket) {
  const src = path.join(INBOX_DIR, `${ticket}.log`);
  if (!fs.existsSync(src)) return false;
  const archDir = path.join(INBOX_DIR, 'archived');
  fs.mkdirSync(archDir, { recursive: true, mode: 0o755 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(archDir, `${ticket}.${stamp}.log`);
  try {
    fs.renameSync(src, dest);
    return dest;
  } catch {
    return false;
  }
}

function handleManagedLine(channel, line) {
  if (channel !== 'MONITOR') return;
  const ticket = extractTicket(line);
  if (!ticket) return;

  if (line.includes(DONE_SENTINEL)) {
    if (completed.has(ticket)) return;
    completed.add(ticket);
    const archived = archiveMode ? archiveChannel(ticket) : false;
    process.stdout.write(
      `  -> [${ticket}] marked COMPLETE` +
        (archived ? ` (archived to ${archived})` : '') +
        ` (total completed: ${completed.size})\n`
    );
    return;
  }

  if (!welcomed.has(ticket)) {
    welcomed.add(ticket);
    sendTo(ticket, WELCOME_MESSAGE);
    process.stdout.write(
      `  -> [${ticket}] first contact — welcome sent (total welcomed: ${welcomed.size})\n`
    );
  }
}

// ─── tail multiplexer ────────────────────────────────────────────────────
const tails = new Map();

function startTail(file) {
  if (tails.has(file)) return;
  const channel = path.basename(file, '.log');
  const proc = spawn('tail', ['-n', '0', '-F', file], { stdio: ['ignore', 'pipe', 'inherit'] });
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length === 0) continue;
      process.stdout.write(`\x07[${channel}] ${line}\n`);
      if (manageMode) handleManagedLine(channel, line);
    }
  });
  proc.on('exit', () => tails.delete(file));
  tails.set(file, proc);
  process.stdout.write(`+ tailing [${channel}]\n`);
}

for (const f of fs.readdirSync(INBOX_DIR)) {
  if (matchesFilter(f)) startTail(path.join(INBOX_DIR, f));
}

process.stdout.write(
  `listening on ${INBOX_DIR}/*.log${filter ? ` (filter: ${filter})` : ''}` +
    ` — ${tails.size} channel(s) at start, auto-attaching new ones.` +
    (manageMode ? ` workflow-manager: ON (auto-welcome${archiveMode ? ' + archive' : ''}).` : '') +
    ' Ctrl-C to stop.\n'
);

const watcher = fs.watch(INBOX_DIR, (eventType, filename) => {
  if (!filename) return;
  if (!matchesFilter(filename)) return;
  const full = path.join(INBOX_DIR, filename);
  if (tails.has(full)) return;
  if (!fs.existsSync(full)) return;
  startTail(full);
});

function shutdown(code) {
  try {
    watcher.close();
  } catch {}
  for (const proc of tails.values()) {
    try {
      proc.kill('SIGTERM');
    } catch {}
  }
  process.exit(code ?? 0);
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
