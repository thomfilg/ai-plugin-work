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
const namespace = require('../scripts/lib/maestro-conduct/namespace');

// Per-namespace mailbox dir when MAESTRO_NS is set (GH-622), else the historical
// global /tmp/claude-agent-inbox. Override with MAESTRO_INBOX_DIR.
const INBOX_DIR = namespace.inboxDir();
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
  // 0o700 dir + atomic 'wx' (O_CREAT|O_EXCL) create: the inbox lives in the
  // shared /tmp tree, so a pre-planted symlink at the predictable channel path
  // could otherwise be followed and truncate a victim file. O_EXCL fails
  // instead of following an existing path (CWE-377 / js/insecure-temporary-file).
  fs.mkdirSync(INBOX_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(INBOX_DIR, `${channel}.log`);
  try {
    fs.writeFileSync(file, '', { flag: 'wx', mode: 0o600 });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e; // already present → it's our mailbox, reuse it
  }
  return file;
}

module.exports = { INBOX_DIR, validateChannelOrExit, ensureChannelFile };
