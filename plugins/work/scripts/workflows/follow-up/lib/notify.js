/**
 * notify.js — outbound operator notifications for /follow-up.
 *
 * The workflow used to reach terminal states (blocked, surface, complete)
 * with the only trace being a JSON blob in the agent transcript — the
 * operator was never told ("agents get stuck with no notifications").
 *
 * Two channels, both fail-open:
 *   1. The file-mailbox at /tmp/claude-agent-inbox/<TICKET>.log — the same
 *      channel maestro/conductor and listen-communication.js already tail,
 *      so fleet tooling picks the event up with no new plumbing.
 *   2. A terminal bell (BEL to stderr) so a human watching the terminal
 *      gets an audible/visual ping even without the mailbox listeners.
 *
 * The inbox is also an INBOUND channel: operators drop lines in the same
 * file (maestro `signal`). `readNewInboxMessages` lets the wait loop break
 * out early when new operator messages arrive instead of sleeping through
 * them.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const FOLLOW_UP_TAG = '[follow-up]';

// Env override keeps tests hermetic (no leftover files in the real mailbox).
function inboxDir() {
  return process.env.CLAUDE_AGENT_INBOX_DIR || '/tmp/claude-agent-inbox';
}

function inboxPath(ticketId) {
  return path.join(inboxDir(), `${ticketId}.log`);
}

/**
 * Append a notification line to the ticket's mailbox and ring the terminal
 * bell. Never throws.
 */
function notifyOperator(ticketId, message) {
  const line = `${FOLLOW_UP_TAG} ${new Date().toISOString()} ${message}\n`;
  try {
    fs.mkdirSync(inboxDir(), { recursive: true });
    fs.appendFileSync(inboxPath(ticketId), line);
  } catch {
    /* fail-open — mailbox is best-effort */
  }
  try {
    process.stderr.write('\x07');
  } catch {
    /* fail-open */
  }
}

/**
 * Read mailbox content appended since `state._inboxOffset`, excluding lines
 * this module wrote itself (FOLLOW_UP_TAG) so our own notifications never
 * wake the wait loop. Advances the offset on state (caller persists state).
 *
 * @returns {string[]} new operator lines (possibly empty)
 */
function readNewInboxMessages(ticketId, state) {
  try {
    const file = inboxPath(ticketId);
    const stat = fs.statSync(file);
    const offset = typeof state._inboxOffset === 'number' ? state._inboxOffset : stat.size;
    if (state._inboxOffset === undefined) {
      // First sighting: start from the current end so historical chatter
      // doesn't replay as "new" messages.
      state._inboxOffset = stat.size;
      return [];
    }
    if (stat.size <= offset) return [];
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buf, 0, buf.length, offset);
      state._inboxOffset = stat.size;
      return buf
        .toString('utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.includes(FOLLOW_UP_TAG));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

module.exports = { notifyOperator, readNewInboxMessages, inboxPath, inboxDir, FOLLOW_UP_TAG };
