#!/usr/bin/env node
// maestro-signal.js — append a line to /tmp/claude-agent-inbox/<CHANNEL>.log
//
// Usage: node maestro-signal.js <CHANNEL> <message...>
//
// Note: the inbox is a human-facing mailbox. Listeners (maestro-listen.js)
// surface lines as bells in a tmux pane for cross-terminal coordination.
// Agents do NOT read the inbox; to message a /work agent, use tmux send-keys
// against its <TICKET>-work session pane.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INBOX_DIR = '/tmp/claude-agent-inbox';

function listListeners(channel) {
  // Best-effort: list pids holding /tmp/claude-agent-inbox/<channel>.log open.
  try {
    const { execSync } = require('node:child_process');
    const out = execSync(`lsof -t '${INBOX_DIR}/${channel}.log' 2>/dev/null || true`, {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
    if (!out) return [];
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function main() {
  const [, , channel, ...msgParts] = process.argv;
  if (!channel || msgParts.length === 0) {
    console.error('usage: maestro-signal <CHANNEL> <message...>');
    process.exit(2);
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(channel)) {
    console.error(`invalid channel name: ${channel}`);
    process.exit(2);
  }
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const file = path.join(INBOX_DIR, `${channel}.log`);
  const line = `[${new Date().toISOString()}] ${msgParts.join(' ')}\n`;
  fs.appendFileSync(file, line);
  const pids = listListeners(channel);
  process.stdout.write(
    `sent → ${file} (${pids.length} listener(s)${pids.length ? `, pids: ${pids.join(', ')}` : ''})\n`
  );
}

main();
