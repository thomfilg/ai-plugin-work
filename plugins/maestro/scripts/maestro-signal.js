#!/usr/bin/env node
// maestro-signal.js — append a line to <inbox>/<CHANNEL>.log
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
const { spawnSync } = require('node:child_process');
const { INBOX_DIR, validateChannelOrExit, ensureChannelFile } = require('../lib/inbox');
const namespace = require('./lib/maestro-conduct/namespace');

function listListeners(channel) {
  // Best-effort: list pids holding <inbox>/<channel>.log open. Use spawnSync
  // argv (no shell) so the INBOX_DIR path (which can carry MAESTRO_NS) and the
  // channel can never be interpreted by a shell (js/indirect-command-line-injection).
  try {
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

// Namespace segment of a tmux session name: "proj-a/GH-42-work" → "proj-a";
// a bare "GH-42-work" → "" (global).
function sessionNsOf(name) {
  const i = name.indexOf('/');
  return i >= 0 ? name.slice(0, i) : '';
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * GH-622 footgun guard (pure): when a signal finds NO listener on the resolved
 * mailbox, warn if an agent session for this channel is running under a
 * DIFFERENT namespace — that is the silent-drop case (operator's MAESTRO_NS
 * doesn't match the agent's, so the message lands in the wrong dir). Returns the
 * warning string, or null when there's nothing to flag.
 */
function buildMismatchWarning({ channel, inboxDir, ownNs, sessionNames }) {
  const re = new RegExp(`(?:^|/)${escapeRe(channel)}-(work|listen|dev)$`);
  const elsewhere = (sessionNames || []).filter((s) => re.test(s) && sessionNsOf(s) !== ownNs);
  if (!elsewhere.length) return null;
  const theirNs = sessionNsOf(elsewhere[0]) || '<their-namespace>';
  const here = ownNs ? `MAESTRO_NS=${ownNs}` : 'the global';
  return (
    `⚠️  0 listeners on ${inboxDir}, but agent session(s) exist in a different namespace: ` +
    `${elsewhere.join(', ')}.\n   This signal went to ${here} mailbox and will NOT reach them. ` +
    `Align namespaces — set MAESTRO_NS=${theirNs} (e.g. in .envrc), or point both halves at one ` +
    `CLAUDE_AGENT_INBOX_DIR / MAESTRO_INBOX_DIR.`
  );
}

function tmuxSessionNames() {
  try {
    const res = spawnSync('tmux', ['ls', '-F', '#{session_name}'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    return (res.stdout || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
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
  if (pids.length === 0) {
    const warn = buildMismatchWarning({
      channel,
      inboxDir: INBOX_DIR,
      ownNs: namespace.ns(),
      sessionNames: tmuxSessionNames(),
    });
    if (warn) process.stderr.write(`${warn}\n`);
  }
}

if (require.main === module) main();

module.exports = { buildMismatchWarning, sessionNsOf };
