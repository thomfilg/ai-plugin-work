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
const { INBOX_DIR, validateChannelOrExit, ensureChannelFile } = require('../lib/inbox');

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
  if (msgParts.length === 0) {
    console.error('usage: maestro-signal <CHANNEL> <message...>');
    process.exit(2);
  }
  validateChannelOrExit(channel, 'maestro-signal <CHANNEL> <message...>');
  const file = ensureChannelFile(channel);
  const line = `[${new Date().toISOString()}] ${msgParts.join(' ')}\n`;
  fs.appendFileSync(file, line);
  const pids = listListeners(channel);
  process.stdout.write(
    `sent → ${file} (${pids.length} listener(s)${pids.length ? `, pids: ${pids.join(', ')}` : ''})\n`
  );
}

main();
