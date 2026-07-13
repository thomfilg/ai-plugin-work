'use strict';

/**
 * session-guard/commands.js — CLI subcommands (called by orchestrator):
 *   init <ticketId> <workflow>   — Create session with passphrase (reuse ticks
 *                                  are silent unless the guard state changed;
 *                                  --show-guard prints the status on demand)
 *   reveal <ticketId>            — Reveal passphrase (sets revealed=true)
 *   complete <ticketId>          — Remove session file (cleanup)
 *   finish <ticketId>            — Atomic teardown: reveal + complete
 *   status [ticketId]            — Show session info
 */

const fs = require('fs');
const path = require('path');

// Canonical git-worktree-root resolver — shared, do not reimplement.
const { resolveWorktreeRoot } = require(path.join(__dirname, '..', '..', 'ticket-validation'));
const { getOwnerSessionId } = require(path.join(__dirname, 'context'));
const {
  findActiveSessions,
  generatePassphrase,
  readSessionFile,
  sessionFilePath,
  writeSessionAtomic,
} = require(path.join(__dirname, 'store'));

/**
 * Announce-state fingerprint for the guard banner (GH-540). The reuse banner
 * prints only when this string differs from the persisted `announcedState`,
 * i.e. on genuine guard transitions — not on every "still active" tick.
 */
function guardAnnounceState(session) {
  return [
    session.ticketId,
    session.workflow,
    session.startTime,
    session.cwd,
    session.ownerSessionId || '',
    session.worktreeRoot || '',
  ].join(':');
}

/**
 * Refresh mutable metadata on a reused session in place. Updates cwd when it
 * changed (same ticket, different directory) and backfills owner metadata on
 * legacy/unstamped sessions:
 *   - owning Claude session id, so the Stop hook can scope the lock to this
 *     terminal (prevents cross-terminal lock bleed when two sessions share
 *     one cwd);
 *   - owning git worktree root, so the Stop hook can scope the lock to this
 *     checkout (prevents bleed across sibling ticket worktrees).
 * Returns true when anything was mutated (i.e. the session needs persisting).
 */
function refreshSessionMetadata(existing, ownerSessionId, worktreeRoot) {
  const currentCwd = process.cwd();
  let dirty = false;
  if (existing.cwd !== currentCwd) {
    existing.cwd = currentCwd;
    dirty = true;
  }
  if (!existing.ownerSessionId && ownerSessionId) {
    existing.ownerSessionId = ownerSessionId;
    dirty = true;
  }
  if (!existing.worktreeRoot && worktreeRoot) {
    existing.worktreeRoot = worktreeRoot;
    dirty = true;
  }
  return dirty;
}

/**
 * Print the reuse banner for an existing session, gated on guard transitions
 * (GH-540): a metadata refresh or a changed announce fingerprint prints; an
 * unchanged tick is silent unless `showGuard` opts back in.
 */
function printReuseBanner(ticketId, existing, dirty, announceChanged, showGuard) {
  if (dirty) {
    process.stderr.write(`Session guard for ${ticketId} updated (cwd/owner).\n`);
  } else if (announceChanged) {
    process.stderr.write(
      `Session guard already active for ${ticketId} (${existing.workflow}). Reusing existing session.\n`
    );
  } else if (showGuard) {
    process.stderr.write(
      `Session guard active for ${ticketId} (${existing.workflow}) since ${existing.startTime}. Reusing existing session.\n`
    );
  }
}

/**
 * Idempotent init path: an existing session for the ticket is reused, only
 * refreshing cwd and backfilling owner metadata on legacy/unstamped sessions.
 *
 * The "already active / reusing" banner is gated on guard transitions (GH-540):
 * it prints only when the announce-state fingerprint changed since the last
 * print. An unchanged tick is silent unless `showGuard` opts back in.
 */
function refreshExistingSession(ticketId, existing, ownerSessionId, worktreeRoot, showGuard) {
  const dirty = refreshSessionMetadata(existing, ownerSessionId, worktreeRoot);
  const announceState = guardAnnounceState(existing);
  const announceChanged = existing.announcedState !== announceState;
  if (announceChanged) {
    existing.announcedState = announceState;
  }
  if (dirty || announceChanged) {
    writeSessionAtomic(ticketId, existing);
  }
  printReuseBanner(ticketId, existing, dirty, announceChanged, showGuard);
  process.exit(0);
}

function cmdInit(ticketId, workflow, opts = {}) {
  if (!ticketId || !workflow) {
    process.stderr.write('Usage: session-guard.js init <ticketId> <workflow>\n');
    process.exit(1);
  }

  const ownerSessionId = getOwnerSessionId();
  const worktreeRoot = resolveWorktreeRoot();

  // Idempotent: reuse existing session if one exists for this ticket
  const existing = readSessionFile(ticketId);
  if (existing && existing.ticketId === ticketId) {
    refreshExistingSession(ticketId, existing, ownerSessionId, worktreeRoot, opts.showGuard);
    return;
  }

  const passphrase = generatePassphrase();
  const session = {
    ticketId,
    workflow,
    passphrase,
    cwd: process.cwd(),
    // Claude session that owns this workflow. Used by the Stop hook to avoid
    // force-holding an unrelated terminal that merely shares this cwd.
    ownerSessionId,
    // Git worktree root that owns this workflow. Used by the Stop hook to avoid
    // force-holding a Stop firing in a different (sibling) worktree.
    worktreeRoot,
    startTime: new Date().toISOString(),
    revealed: false,
  };
  // Stamp the announce fingerprint so the next reuse tick stays silent (GH-540).
  session.announcedState = guardAnnounceState(session);

  writeSessionAtomic(ticketId, session);
  process.stderr.write(
    `Session guard active for ${ticketId} (${workflow}). Locked until all steps complete.\n`
  );
  process.exit(0);
}

function cmdReveal(ticketId) {
  if (!ticketId) {
    process.stderr.write('Usage: session-guard.js reveal <ticketId>\n');
    process.exit(1);
  }

  const session = readSessionFile(ticketId);
  if (!session) {
    process.stderr.write(`No active session for ${ticketId} (skipping reveal)\n`);
    process.exit(0); // fail-open: don't break complete step if guard wasn't initialized
  }

  // Output passphrase to stdout
  process.stdout.write(session.passphrase + '\n');

  // Update revealed flag
  session.revealed = true;
  writeSessionAtomic(ticketId, session);
  process.exit(0);
}

function cmdComplete(ticketId, workflowFilter) {
  if (!ticketId) {
    process.stderr.write('Usage: session-guard.js complete <ticketId> [workflow]\n');
    process.exit(1);
  }

  // If a workflow filter is provided, only clear when the active session
  // belongs to that workflow. Prevents a sub-workflow (e.g. /follow-up)
  // from tearing down a parent workflow's session (e.g. /work).
  if (workflowFilter) {
    const existing = readSessionFile(ticketId);
    if (existing && existing.workflow && existing.workflow !== workflowFilter) {
      process.stderr.write(
        `Session for ${ticketId} owned by ${existing.workflow} — ${workflowFilter} complete is a no-op.\n`
      );
      process.exit(0);
    }
  }

  try {
    fs.unlinkSync(sessionFilePath(ticketId));
  } catch {
    /* already gone — fine */
  }
  process.stderr.write(`Session guard cleared for ${ticketId}\n`);
  process.exit(0);
}

/**
 * Atomic teardown: reveal passphrase then remove session file.
 * Replaces the fragile 3-step agent prompt with a single command.
 * Fail-open: exits 0 if no session exists (guard may be disabled).
 */
function cmdFinish(ticketId) {
  if (!ticketId) {
    process.stderr.write('Usage: session-guard.js finish <ticketId>\n');
    process.exit(1);
  }

  const session = readSessionFile(ticketId);
  if (!session) {
    process.stderr.write(`No active session for ${ticketId} (skipping finish)\n`);
    process.exit(0);
  }

  // Reveal passphrase (unlock Stop hook)
  process.stdout.write(session.passphrase + '\n');
  session.revealed = true;
  writeSessionAtomic(ticketId, session);

  // Clean up session file
  try {
    fs.unlinkSync(sessionFilePath(ticketId));
  } catch {
    /* already gone — fine */
  }
  process.stderr.write(`Session guard finished for ${ticketId}\n`);
  process.exit(0);
}

/** Public status shape — never includes the passphrase. */
function sessionSummary(session) {
  return {
    ticketId: session.ticketId,
    workflow: session.workflow,
    startTime: session.startTime,
    revealed: session.revealed,
  };
}

function cmdStatus(ticketId) {
  if (ticketId) {
    const session = readSessionFile(ticketId);
    if (session) {
      process.stdout.write(JSON.stringify(sessionSummary(session), null, 2) + '\n');
    } else {
      process.stdout.write(`No active session for ${ticketId}\n`);
    }
  } else {
    const sessions = findActiveSessions();
    if (sessions.length === 0) {
      process.stdout.write('No active sessions\n');
    } else {
      process.stdout.write(JSON.stringify(sessions.map(sessionSummary), null, 2) + '\n');
    }
  }
  process.exit(0);
}

module.exports = { cmdComplete, cmdFinish, cmdInit, cmdReveal, cmdStatus };
