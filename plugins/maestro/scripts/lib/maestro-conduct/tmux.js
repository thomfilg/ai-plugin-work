/**
 * tmux.js — tmux session helpers.
 *
 * Pure side-effect wrappers around tmux CLI calls. No detection logic.
 */
const { execSync, spawnSync } = require('child_process');

function sh(cmd) {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch {
    return '';
  }
}

/**
 * Run a command via argv (no shell) so arguments containing shell metacharacters
 * (backticks, $, \, quotes) cannot trigger command substitution or word-splitting.
 * Returns true on exit code 0, false otherwise.
 */
function spawnVoid(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: 'ignore' });
  return res.status === 0;
}

/** Run a command via argv and return stdout, or '' on failure. */
function spawnOut(cmd, args) {
  const res = spawnSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  if (res.status !== 0 || !res.stdout) return '';
  return res.stdout.toString();
}

/**
 * Resolve the ticket prefix used to build the default session-name regex.
 *
 * Mirrors resolve-prefix.sh (sourced by maestro-bootstrap.sh) so the JS
 * orchestrator and the bootstrap shell helper cannot drift to different
 * prefixes. Honors the TICKET_PREFIX env var (set by callers that have already
 * resolved the provider) and falls back to "GH" on empty/invalid values, using
 * the same strict ^[A-Z][A-Z0-9]*$ validation as the shell helper.
 */
function resolveTicketPrefix() {
  const raw = process.env.TICKET_PREFIX || '';
  return /^[A-Z][A-Z0-9]*$/.test(raw) ? raw : 'GH';
}

// Suffixes the conductor tracks. Default discovery widens to -work plus the
// -dev / -listen helper sessions /work spawns, mirroring maestro-conduct.sh's
// SESSION_SUFFIX_ALT. Auto-restart is gated separately to -work only (see
// restartEligible in maestro-conduct.js), so helper sessions surface
// informationally but never get relaunched.
const SESSION_SUFFIX_ALT = 'work|dev|listen';

/**
 * List sessions matching a regex.
 *
 * Default pattern is built dynamically from TICKET_PREFIX (default "GH") so
 * non-GitHub providers (Linear ECHO-*, Jira PROJ-*, etc.) are discovered too.
 * The default suffix set is `work|dev|listen` so helper sessions surface
 * informationally. Callers can pass an explicit RegExp to override entirely;
 * `SESSION_PATTERN` env wins over the dynamic default.
 */
function listSessions(pattern) {
  let regex = pattern;
  if (!regex) {
    if (process.env.SESSION_PATTERN) {
      regex = new RegExp(process.env.SESSION_PATTERN);
    } else {
      // Numeric ticket-id portion only ([0-9]+) — same as the bash original.
      // A character class including '-' here would let "GH-42-dev-work"
      // greedily consume the helper-suffix, with the suffix group then
      // matching '-work' and yielding the wrong ticket id "GH-42-dev".
      regex = new RegExp(`^${resolveTicketPrefix()}-[0-9]+-(${SESSION_SUFFIX_ALT})$`);
    }
  }
  return sh('tmux ls 2>/dev/null')
    .split('\n')
    .map((l) => l.split(':')[0])
    .filter((name) => regex.test(name));
}

/**
 * Strip the maestro session-suffix (`-work`, `-dev`, `-listen`) to derive the
 * underlying ticket id. Mirrors ticket_id_for from maestro-conduct.sh.
 */
function ticketIdFor(session) {
  return session.replace(new RegExp(`-(${SESSION_SUFFIX_ALT})$`), '');
}

/** Capture pane (visible + extra scrollback so tall menus aren't truncated). */
function capture(session) {
  return spawnOut('tmux', ['capture-pane', '-t', session, '-p', '-S', '-100']);
}

/**
 * Send a literal string into a session prompt + Enter to submit.
 *
 * Uses spawnSync argv form (no shell) so shell metacharacters in `text`
 * (e.g. backticks, $, \, quotes) — which can flow in from external sources
 * like bot review titles fetched via the GitHub API — cannot trigger
 * command substitution or arbitrary shell execution.
 */
function sendLine(session, text) {
  // -l forces literal delivery so short strings like "Enter" or "Space" can't
  // collide with tmux's key-name table.
  // End ensures we're at end-of-line so Enter submits instead of inserting newline.
  spawnVoid('tmux', ['send-keys', '-l', '-t', session, String(text)]);
  spawnVoid('tmux', ['send-keys', '-t', session, 'End']);
  spawnVoid('tmux', ['send-keys', '-t', session, 'Enter']);
}

/** Send a raw key (Escape, Enter, etc.). */
function sendKey(session, key) {
  spawnVoid('tmux', ['send-keys', '-t', session, String(key)]);
}

/** Ensure a session exists; create it as a no-op holding session if missing. */
function ensureSession(session) {
  if (spawnVoid('tmux', ['has-session', '-t', session])) return;
  // The holding-loop body is a fixed string literal — not user-controlled — so
  // executing it through `sh -c` here is safe. The session name is passed as a
  // separate argv element so it cannot break out of the argument boundary.
  spawnVoid('tmux', [
    'new-session',
    '-d',
    '-s',
    session,
    'while :; do read line; echo "[$(date +%T)] $line"; done',
  ]);
}

module.exports = {
  listSessions,
  capture,
  sendLine,
  sendKey,
  ensureSession,
  ticketIdFor,
  resolveTicketPrefix,
  SESSION_SUFFIX_ALT,
};
