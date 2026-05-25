'use strict';

/**
 * Shared helpers for the maestro file-mailbox at /tmp/claude-agent-inbox/.
 *
 * `signal` writes lines; `listen` tails. Both validate the channel name and
 * ensure the inbox dir + log file exist. Centralised here so jscpd doesn't
 * flag the boilerplate as duplicate-blocks.
 */

const fs = require('node:fs');
const path = require('node:path');

const INBOX_DIR = '/tmp/claude-agent-inbox';
const VALID_CHANNEL = /^[A-Za-z0-9_.-]+$/;

function validateChannelOrExit(channel, usage) {
  if (!channel) {
    console.error(`usage: ${usage}`);
    process.exit(2);
  }
  if (!VALID_CHANNEL.test(channel)) {
    console.error(`invalid channel name: ${channel}`);
    process.exit(2);
  }
}

function ensureChannelFile(channel) {
  fs.mkdirSync(INBOX_DIR, { recursive: true });
  const file = path.join(INBOX_DIR, `${channel}.log`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  return file;
}

module.exports = { INBOX_DIR, validateChannelOrExit, ensureChannelFile };
