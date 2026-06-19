'use strict';
/**
 * namespace.js — derive per-instance ("namespace") locations + session names so
 * N maestro conductors can run isolated on one machine (GH-622).
 *
 * A namespace is set via MAESTRO_NS (e.g. a repo or worktree key). When it is
 * unset, every getter returns the historical machine-global default
 * byte-for-byte, so existing single-conductor setups are unaffected.
 *
 * Explicit per-resource env vars (STATE_DIR, LOG_FILE, ALERT_FILE,
 * ALERT_SESSION, MAESTRO_INBOX_DIR, SESSION_PATTERN) always win over the
 * NS-derived default — an operator can still pin any single resource.
 *
 * Resolution is fail-open: an empty or malformed MAESTRO_NS collapses to the
 * global default rather than throwing, mirroring resolveTicketPrefix().
 */
const os = require('os');
const path = require('path');

// A namespace becomes a path segment, a filename infix, and a tmux session-name
// segment, so restrict it to characters that are safe in all three (no `/`,
// `.`, `:`, or whitespace). Invalid values fail open to the global default.
const NS_RE = /^[A-Za-z0-9_-]+$/;

/** The active namespace, or '' when unset/invalid (global, back-compat). */
function ns() {
  const raw = (process.env.MAESTRO_NS || '').trim();
  return NS_RE.test(raw) ? raw : '';
}

/** tmux session-name segment: "<ns>/" when namespaced, else "". */
function sessionSeg() {
  const n = ns();
  return n ? `${n}/` : '';
}

/** Per-namespace marker directory (state.js). */
function stateDir() {
  if (process.env.STATE_DIR) return process.env.STATE_DIR;
  const base = path.join(os.homedir(), '.cache', 'maestro-conduct');
  const n = ns();
  return n ? path.join(base, n) : base;
}

/** /tmp/<base>[-<ns>]<ext> */
function tmpFile(base, ext) {
  const n = ns();
  return path.join('/tmp', `${base}${n ? `-${n}` : ''}${ext}`);
}

function logFile() {
  return process.env.LOG_FILE || tmpFile('maestro-conduct', '.log');
}

function alertFile() {
  return process.env.ALERT_FILE || tmpFile('maestro-alerts', '.jsonl');
}

function alertSession() {
  if (process.env.ALERT_SESSION) return process.env.ALERT_SESSION;
  const n = ns();
  return n ? `maestro-alerts-${n}` : 'maestro-alerts';
}

/** Human-facing file-mailbox directory (inbox.js). */
function inboxDir() {
  if (process.env.MAESTRO_INBOX_DIR) return process.env.MAESTRO_INBOX_DIR;
  const base = '/tmp/claude-agent-inbox';
  const n = ns();
  return n ? path.join(base, n) : base;
}

/** Singleton-guard lockfile, co-located with the namespace's state dir. */
function lockFile() {
  return path.join(stateDir(), 'conductor.lock');
}

// ── Session-name helpers ────────────────────────────────────────────────────

/** Build a maestro session name, NS-scoped: "[<ns>/]<ticket>-<suffix>". */
function sessionName(ticket, suffix) {
  return `${sessionSeg()}${ticket}-${suffix}`;
}

/**
 * Strip the optional "<ns>/" prefix and the "-<suffix>" tail to recover the
 * bare ticket id. `suffixAlt` is the alternation (e.g. "work|dev|listen").
 */
function ticketIdFor(session, suffixAlt) {
  const slash = session.indexOf('/');
  const noSeg = slash >= 0 ? session.slice(slash + 1) : session;
  return noSeg.replace(new RegExp(`-(${suffixAlt})$`), '');
}

/**
 * Flatten a persistence key: strip any leading "<ns>/" segment from a value
 * that may be a full tmux session name (e.g. "proj-a/GH-42-work" → "GH-42-work").
 *
 * Marker files and alert-count keys live under per-namespace stores
 * (namespace.stateDir()), so the namespace is already encoded in the path — a
 * "/" left in the key would make path.join target a non-existent nested dir and
 * would break the flat-`<id>`-prefixed matchers in maestro-cleanup.js. Bare
 * ids and global (non-namespaced) names contain no "/", so this is a no-op for
 * them (GH-622).
 */
function flattenKey(key) {
  return String(key).replace(/^.*\//, '');
}

/** Escape a literal string for inclusion in a RegExp source. */
function reEscape(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Default discovery regex, NS-scoped. `prefix` e.g. "GH", `suffixAlt` e.g.
 * "work|dev|listen". When namespaced, only sessions under "<ns>/" match, so a
 * second conductor in another namespace never sees this batch's agents.
 */
function defaultSessionPattern(prefix, suffixAlt) {
  return new RegExp(`^${reEscape(sessionSeg())}${prefix}-[0-9]+-(${suffixAlt})$`);
}

module.exports = {
  ns,
  sessionSeg,
  stateDir,
  logFile,
  alertFile,
  alertSession,
  inboxDir,
  lockFile,
  sessionName,
  ticketIdFor,
  flattenKey,
  defaultSessionPattern,
};
