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
const { INBOX_DIR, validateChannelOrExit, ensureChannelFile } = require('../lib/inbox');

function listListeners(channel) {
  // Best-effort: list pids holding <inbox>/<channel>.log open. Use spawnSync
  // argv (no shell) so the INBOX_DIR path (which can carry MAESTRO_NS) and the
  // channel can never be interpreted by a shell (js/indirect-command-line-injection).
  try {
    const { spawnSync } = require('node:child_process');
    const res = spawnSync('lsof', ['-t', path.join(INBOX_DIR, `${channel}.log`)], {
      encoding: 'utf8',
      timeout: 2000,
    });
    const out = (res.stdout || '').trim();
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
