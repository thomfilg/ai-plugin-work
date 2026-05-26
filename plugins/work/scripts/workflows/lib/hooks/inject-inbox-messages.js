#!/usr/bin/env node

/**
 * inject-inbox-messages.js — PostToolUse hook
 *
 * Reads new lines from the per-ticket inbox file
 * (`/tmp/claude-agent-inbox/<TICKET>.log`) and writes them to stderr so
 * they land in the agent's tool result. This is how monitor messages
 * actually wake the agent — without this, the listener-tmux pane just
 * shows messages to a human, but the Claude session never sees them.
 *
 * Cursor state lives at `~/.claude/work-workflow/state/inbox-cursors.json`
 * keyed by ticket. Each value is the line count we've already delivered;
 * only later lines are emitted on the next fire. Cursor advances after
 * a successful read so the same message is never injected twice.
 *
 * Fails open: any error → exit 0 with no output. Logging must never
 * break the workflow.
 *
 * Disable with `INJECT_INBOX=0`.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function fail() {
  process.exit(0);
}

if (process.env.INJECT_INBOX === '0') fail();

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function deriveTicket(hookData) {
  // Priority order: transcript_path > tool_input.command > .git/HEAD of cwd
  const tp = hookData?.transcript_path;
  if (typeof tp === 'string') {
    const m = tp.match(/\b[A-Z]+-\d+\b/);
    if (m) return m[0];
  }
  const cmd = hookData?.tool_input?.command;
  if (typeof cmd === 'string') {
    const m = cmd.match(/\b[A-Z]+-\d+\b/);
    if (m) return m[0];
  }
  try {
    const head = fs.readFileSync(path.join(process.cwd(), '.git', 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : head;
    const m = ref.match(/[A-Z]+-\d+/);
    if (m) return m[0];
  } catch {
    /* ignore */
  }
  return null;
}

function cursorFile() {
  const dir = path.join(os.homedir(), '.claude', 'work-workflow', 'state');
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  } catch {
    /* ignore */
  }
  return path.join(dir, 'inbox-cursors.json');
}

function readCursors() {
  try {
    return JSON.parse(fs.readFileSync(cursorFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeCursors(c) {
  try {
    const f = cursorFile();
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(c), { mode: 0o644 });
    fs.renameSync(tmp, f);
  } catch {
    /* ignore */
  }
}

function inboxPath(ticket) {
  const dir = process.env.CLAUDE_AGENT_INBOX_DIR || '/tmp/claude-agent-inbox';
  return path.join(dir, `${ticket}.log`);
}

function main() {
  const raw = readStdin();
  if (!raw.trim()) fail();
  let hookData;
  try {
    hookData = JSON.parse(raw);
  } catch {
    fail();
  }

  const ticket = deriveTicket(hookData);
  if (!ticket) fail();

  const file = inboxPath(ticket);
  if (!fs.existsSync(file)) fail();

  let lines;
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    fail();
  }

  const cursors = readCursors();
  const last = Number(cursors[ticket] || 0);
  if (lines.length <= last) fail(); // nothing new

  const fresh = lines.slice(last);
  cursors[ticket] = lines.length;
  writeCursors(cursors);

  // Cap at last 5 fresh lines to avoid flooding the agent if many piled up.
  const toShow = fresh.slice(-5);
  process.stderr.write(
    `\n=== Monitor messages for ${ticket} (${toShow.length}/${fresh.length} new) ===\n` +
      toShow.map((l) => `[MONITOR] ${l}`).join('\n') +
      '\n=== end monitor messages ===\n'
  );
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0);
}
