#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const INBOX_DIR = process.env.CLAUDE_AGENT_INBOX_DIR || '/tmp/claude-agent-inbox';

const filter = process.argv[2] || null;

fs.mkdirSync(INBOX_DIR, { recursive: true, mode: 0o755 });

function matchesFilter(name) {
  if (!name.endsWith('.log')) return false;
  if (filter && !name.toUpperCase().includes(filter.toUpperCase())) return false;
  return true;
}

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
    ` — ${tails.size} channel(s) at start, auto-attaching new ones. Ctrl-C to stop.\n`
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
