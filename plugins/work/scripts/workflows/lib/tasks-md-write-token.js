'use strict';

/**
 * tasks-md-write-token.js — one-shot write token for the root-level tasks.md.
 *
 * Breaks the coverage_check ↔ protect-tasks-md deadlock (ECHO-5139/5145/5218/
 * 5320/5350/5818/5821 family): completion-next.js's `coverage_check` phase can
 * legitimately demand a tasks.md repair (add/flip the `## Requirement
 * Coverage` table) while the `protect-tasks-md` PreToolUse hook blocks every
 * tasks.md write during the `check` step. Without an escape hatch the runner
 * enters an unrecoverable blocked state.
 *
 * Mechanism (mirrors lib/scripts/write-report.js hook-minted tokens, with the
 * direction reversed — the RUNNER mints, the HOOK honors):
 *   1. When coverage_check blocks with a tasks.md-repair demand,
 *      completion-next.js mints `<TOKEN_DIR>/protect-tasks-md.js.<TICKET>`
 *      containing `{ ticket, timestamp, reason }`.
 *   2. The protect-tasks-md hook, at the moment it would otherwise BLOCK a
 *      root-level tasks.md write for that ticket, consumes the token
 *      (read + delete, one-shot) and allows the single write instead.
 *   3. Expired (> TOKEN_MAX_AGE_MS) or future-dated tokens are consumed but
 *      NOT honored, so a stale mint can never be replayed later.
 *
 * The token only unlocks tasks.md for the ticket it was minted for, and only
 * for one write. Re-running completion-next.js re-mints when the phase still
 * blocks — there is always a permitted repair path, never a dead end.
 *
 * TOKEN_DIR honors CLAUDE_WRITE_TOKEN_DIR (same override the phase-runner
 * uses) so tests can isolate the directory.
 */

const fs = require('node:fs');
const path = require('node:path');

const TOKEN_BASENAME = 'protect-tasks-md.js';

/**
 * Generous-but-bounded TTL: unlike hook-minted tokens (10s — consumed by the
 * very next process), this token is minted when the runner BLOCKS and is
 * consumed only after the agent reads the block message and issues an Edit —
 * potentially minutes later.
 */
const TOKEN_MAX_AGE_MS = 15 * 60 * 1000;

function tokenDir() {
  return process.env.CLAUDE_WRITE_TOKEN_DIR || '/tmp/.claude-write-tokens';
}

/** Token file path for a ticket (sanitized), e.g. `.../protect-tasks-md.js.ECHO-5818`. */
function tokenPathFor(ticketId) {
  const safe = String(ticketId || '').replace(/[^A-Za-z0-9_-]/g, '_');
  return path.join(tokenDir(), safe ? `${TOKEN_BASENAME}.${safe}` : TOKEN_BASENAME);
}

/**
 * Mint a one-shot tasks.md write token for `ticketId`.
 * Returns true on success, false on any error (minting is best-effort — the
 * runner's block message tells the agent to re-run if the token is missing).
 */
function mintTasksMdWriteToken(ticketId, meta = {}) {
  if (!ticketId) return false;
  try {
    fs.mkdirSync(tokenDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      tokenPathFor(ticketId),
      JSON.stringify({ ticket: ticketId, timestamp: Date.now(), ...meta }),
      { mode: 0o600 }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Consume (read + delete) the token for `ticketId` and report whether it is
 * valid. One-shot: the file is deleted even when validation fails, so an
 * expired or malformed token cannot be retried/replayed.
 *
 * @returns {boolean} true iff a fresh, ticket-matching token was present.
 */
/**
 * Read + delete the token file (one-shot regardless of validity).
 * Returns the raw content, or null when absent / not a regular file.
 */
function takeTokenFile(tp) {
  let raw;
  try {
    const stat = fs.lstatSync(tp);
    if (!stat.isFile()) return null; // symlink or dir — never honor
    raw = fs.readFileSync(tp, 'utf8');
  } catch {
    return null; // no token
  }
  try {
    fs.unlinkSync(tp); // delete immediately — one-shot regardless of validity
  } catch {
    /* already deleted — race is fine */
  }
  return raw;
}

/** True iff the parsed token is fresh (not expired/future-dated) and ticket-matching. */
function tokenIsValid(raw, ticketId) {
  let token;
  try {
    token = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof token.timestamp !== 'number' || !Number.isFinite(token.timestamp)) return false;
  const age = Date.now() - token.timestamp;
  if (age < 0 || age > TOKEN_MAX_AGE_MS) return false; // expired or future-dated
  return typeof token.ticket === 'string' && token.ticket === ticketId;
}

function consumeTasksMdWriteToken(ticketId) {
  if (!ticketId) return false;
  const raw = takeTokenFile(tokenPathFor(ticketId));
  if (raw === null) return false;
  return tokenIsValid(raw, ticketId);
}

module.exports = {
  TOKEN_BASENAME,
  TOKEN_MAX_AGE_MS,
  tokenPathFor,
  mintTasksMdWriteToken,
  consumeTasksMdWriteToken,
};
