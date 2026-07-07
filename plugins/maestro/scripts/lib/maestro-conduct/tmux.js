/**
 * tmux.js — tmux session helpers.
 *
 * Pure side-effect wrappers around tmux CLI calls. No detection logic.
 */
const { execSync, spawnSync } = require('child_process');
const namespace = require('./namespace');
const { isCodexPaneDialect } = require('./live-spinner');

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
 * Prefix alternation for session discovery. TICKET_PREFIX env is the primary
 * source, but the daemon and bootstrap are separate process launches and
 * forgetting the env on ONE of them silently blinded the conductor to a whole
 * fleet (an ECHO-* batch was hunted as GH-*). The orchestration manifests
 * already record every ticket id, so their prefixes are added automatically —
 * the manifest is the single source of truth the env used to duplicate.
 */
function discoveryPrefixAlternation() {
  const prefixes = new Set([resolveTicketPrefix()]);
  try {
    const manifest = require('./manifest');
    for (const file of manifest.listManifestFiles()) {
      const m = manifest.readManifest(file);
      if (!m || !Array.isArray(m.tasks)) continue;
      for (const t of m.tasks) {
        const match = /^([A-Z][A-Z0-9]*)-\d+$/.exec((t && t.id) || '');
        if (match) prefixes.add(match[1]);
      }
    }
  } catch {
    /* fail-open: env/default prefix only */
  }
  const list = [...prefixes];
  return list.length === 1 ? list[0] : `(?:${list.join('|')})`;
}

/**
 * List sessions matching a regex.
 *
 * Default pattern is built dynamically from TICKET_PREFIX (default "GH") plus
 * every prefix found in orchestration manifests, so non-GitHub providers
 * (Linear ECHO-*, Jira PROJ-*, etc.) are discovered even when the env var was
 * only set on the bootstrap side. The default suffix set is `work|dev|listen`
 * so helper sessions surface informationally. Callers can pass an explicit
 * RegExp to override entirely; `SESSION_PATTERN` env wins over the dynamic
 * default.
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
      // namespace.defaultSessionPattern prepends the "<ns>/" segment when
      // MAESTRO_NS is set so a second conductor in another namespace never
      // discovers this batch's agents (GH-622).
      regex = namespace.defaultSessionPattern(discoveryPrefixAlternation(), SESSION_SUFFIX_ALT);
    }
  }
  return sh('tmux ls 2>/dev/null')
    .split('\n')
    .map((l) => l.split(':')[0])
    .filter((name) => regex.test(name));
}

/**
 * Strip the optional "<ns>/" segment and the maestro session-suffix
 * (`-work`, `-dev`, `-listen`) to derive the underlying ticket id.
 * Mirrors ticket_id_for from maestro-conduct.sh.
 */
function ticketIdFor(session) {
  return namespace.ticketIdFor(session, SESSION_SUFFIX_ALT);
}

/** Build an NS-scoped maestro session name: "[<ns>/]<ticket>-<suffix>". */
function sessionName(ticket, suffix) {
  return namespace.sessionName(ticket, suffix);
}

/** Capture pane (visible + extra scrollback so tall menus aren't truncated). */
function capture(session) {
  return spawnOut('tmux', ['capture-pane', '-t', session, '-p', '-S', '-100']);
}

/**
 * Send a literal string into a session prompt + Enter to submit, then VERIFY
 * the submission (receipt contract, GH-449 mode 6/10).
 *
 * `tmux send-keys … Enter` is fire-and-forget: the Enter is delivered to the
 * pty, but a busy TUI can swallow it, leaving the text sitting unsubmitted in
 * the composer. Observed repeatedly in live fleets — a directive sat queued
 * for 1.5h while its agent idled; three agents were found overnight with
 * conductor text frozen in their input boxes. So after sending we capture the
 * pane: if the composer (`❯ …`) still shows our text, we retry Enter once via
 * the alternate C-m keycode, re-check, and report.
 *
 * Returns a delivery status the caller should log:
 *   'submitted' | 'submitted-on-retry' | 'stuck-in-composer' |
 *   'submitted-unverified' (codex dialects — see below)
 *
 * Receipt verification is CLAUDE-TUI-only (WP-09): the `❯` composer glyph is
 * claude's. Codex dialects skip the probe — an exec pane has no composer at
 * all and the codex TUI grammar is unknown until fixtures land — and report
 * 'submitted-unverified' so operators can grep for undelivered directives.
 *
 * Uses spawnSync argv form (no shell) so shell metacharacters in `text`
 * (e.g. backticks, $, \, quotes) — which can flow in from external sources
 * like bot review titles fetched via the GitHub API — cannot trigger
 * command substitution or arbitrary shell execution.
 */
function sendLine(session, text, dialect) {
  // Newlines would submit mid-text under send-keys -l; flatten to a marker.
  const str = String(text).replace(/\r?\n/g, ' ⏎ ');
  // -l forces literal delivery so short strings like "Enter" or "Space" can't
  // collide with tmux's key-name table.
  // End ensures we're at end-of-line so Enter submits instead of inserting newline.
  spawnVoid('tmux', ['send-keys', '-l', '-t', session, str]);
  spawnVoid('tmux', ['send-keys', '-t', session, 'End']);
  spawnVoid('tmux', ['send-keys', '-t', session, 'Enter']);
  if (isCodexPaneDialect(dialect)) return 'submitted-unverified';
  // Receipt check. Probe on a short prefix: the composer renders at most one
  // pane-width of our text before wrapping.
  const probe = str.slice(0, 25);
  if (!probe.trim()) return 'submitted';
  const stillQueued = () =>
    spawnOut('tmux', ['capture-pane', '-t', session, '-p'])
      .split('\n')
      .some((l) => /^\s*❯\s/.test(l) && l.includes(probe));
  const verifyDelay = process.env.MAESTRO_SEND_VERIFY_DELAY_SEC || '0.7';
  if (verifyDelay !== '0') spawnSync('sleep', [verifyDelay]);
  if (!stillQueued()) return 'submitted';
  // Enter didn't land — retry once via C-m (a distinct key path that has
  // empirically submitted when Enter did not).
  spawnVoid('tmux', ['send-keys', '-t', session, 'End']);
  spawnVoid('tmux', ['send-keys', '-t', session, 'C-m']);
  if (verifyDelay !== '0') spawnSync('sleep', [verifyDelay]);
  return stillQueued() ? 'stuck-in-composer' : 'submitted-on-retry';
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
  sessionName,
  resolveTicketPrefix,
  SESSION_SUFFIX_ALT,
};
