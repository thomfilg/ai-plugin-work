/**
 * Marker file management for workflow session detection.
 *
 * Marker files (.work.pid, .follow-up-orchestrator.pid, .check2-orchestrator.pid)
 * let PostToolUse hooks detect an active workflow. Because every agent shares one
 * TASKS_BASE, a marker MUST carry the identity of the terminal that owns it so a
 * hook firing in worktree/session A never advances a workflow owned by B:
 *   - sessionId    — the owning Claude session (CLAUDE_CODE_SESSION_ID), the exact
 *                    per-terminal key.
 *   - worktreeRoot — the owning git worktree, the per-checkout key.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Identity of the terminal that owns a marker. Both fields are null when
 * unavailable (plain CLI / older harness) — the finder treats null as "unknown"
 * and falls back to legacy first-match rather than poisoning the comparison.
 * @returns {{ sessionId: string|null, worktreeRoot: string|null }}
 */
function ownerStamp() {
  const { resolveWorktreeRoot } = require(
    path.join(__dirname, '..', '..', 'lib', 'ticket-validation')
  );
  return {
    sessionId: process.env.CLAUDE_CODE_SESSION_ID || null,
    worktreeRoot: resolveWorktreeRoot(),
  };
}

/**
 * Write the /work marker file (.work.pid) stamped with owner identity.
 * @param {string} ticket - Raw ticket ID
 * @param {object} deps - { TASKS_BASE, tp }
 */
function writeMarkerFile(ticket, deps) {
  const { TASKS_BASE, tp } = deps;
  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  const safeBase = tp.sanitizeTicketIdForPath(ticket.toUpperCase(), providerConfig);
  const tasksDir = path.join(TASKS_BASE, safeBase);
  try {
    fs.mkdirSync(tasksDir, { recursive: true });
    const markerPath = path.join(tasksDir, '.work.pid');
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ ticket, startedAt: new Date().toISOString(), ...ownerStamp() })
    );
  } catch {
    /* fail-open */
  }
}

/**
 * Scan TASKS_BASE for the active marker of the given filename that the CURRENT
 * terminal owns. Reusable across workflows via the markerFilename parameter
 * (e.g. '.work.pid', '.follow-up-orchestrator.pid', '.check2-orchestrator.pid').
 *
 * Scoping (kills cross-wiring under concurrent agents): a marker is skipped when
 * it carries an identity field that differs from the caller's — a different
 * sessionId OR a different worktreeRoot. A marker explicitly owned by the caller
 * is preferred; otherwise the first non-foreign marker is returned, which keeps
 * single-agent / legacy-marker behavior (markers without identity, or an unknown
 * caller, are never foreign).
 *
 * @param {string} tasksBase
 * @param {string} markerFilename
 * @param {{ sessionId?: string|null, worktreeRoot?: string|null }} [caller] - defaults to the current terminal
 * @returns {object|null} parsed marker or null
 */
function findActiveMarker(tasksBase, markerFilename, caller = ownerStamp()) {
  const isForeign = (m) =>
    Boolean(m?.sessionId && caller?.sessionId && m.sessionId !== caller.sessionId) ||
    Boolean(m?.worktreeRoot && caller?.worktreeRoot && m.worktreeRoot !== caller.worktreeRoot);
  const isOwned = (m) =>
    Boolean(m?.sessionId && m.sessionId === caller?.sessionId) ||
    Boolean(m?.worktreeRoot && m.worktreeRoot === caller?.worktreeRoot);

  const candidates = [];
  try {
    for (const entry of fs.readdirSync(tasksBase, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const markerPath = path.join(tasksBase, entry.name, markerFilename);
      if (!fs.existsSync(markerPath)) continue;
      try {
        candidates.push(JSON.parse(fs.readFileSync(markerPath, 'utf8')));
      } catch {
        /* skip corrupt marker */
      }
    }
  } catch {
    return null; // fail-open: tasksBase unreadable
  }

  const notForeign = candidates.filter((m) => !isForeign(m));
  // Prefer an explicitly-owned marker over a merely-non-foreign legacy one.
  return notForeign.find((m) => isOwned(m)) || notForeign[0] || null;
}

module.exports = { writeMarkerFile, ownerStamp, findActiveMarker };
