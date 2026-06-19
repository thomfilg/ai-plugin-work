'use strict';

/**
 * inbox-dir.js — NS-aware resolution of the agent file-mailbox directory,
 * shared by communicate.js / listen-all.js / listen-communication.js so /work
 * messaging lands in the SAME per-namespace mailbox maestro uses when it runs
 * agents under MAESTRO_NS (GH-622). Without a namespace this is byte-for-byte
 * the historical global `/tmp/claude-agent-inbox`.
 *
 * Precedence: explicit CLAUDE_AGENT_INBOX_DIR wins; otherwise the global base
 * is nested under a validated MAESTRO_NS. The default NS-derived path matches
 * maestro's namespace.inboxDir() so both halves of the channel agree.
 */
const path = require('node:path');

// Same allowlist maestro uses: a namespace becomes a path segment, so reject
// anything outside [A-Za-z0-9_-] (and empty) — fail open to the global mailbox.
const NS_RE = /^[A-Za-z0-9_-]+$/;

function resolveInboxDir() {
  if (process.env.CLAUDE_AGENT_INBOX_DIR) return process.env.CLAUDE_AGENT_INBOX_DIR;
  const base = '/tmp/claude-agent-inbox';
  const ns = (process.env.MAESTRO_NS || '').trim();
  return NS_RE.test(ns) ? path.join(base, ns) : base;
}

module.exports = { resolveInboxDir };
