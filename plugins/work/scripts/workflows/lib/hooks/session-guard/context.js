'use strict';

/**
 * session-guard/context.js — ticket/session/worktree context resolution.
 *
 * Answers "who owns the current terminal?": the ticket id (env override or
 * git branch), the owning session id, the owning worktree root, and the
 * per-ticket workflow state files under TASKS_BASE.
 */

const fs = require('fs');
const path = require('path');

// Cached TASKS_BASE resolution — loaded once per invocation
const getConfig = require(path.join(__dirname, '..', '..', 'get-config'));

let _tasksBase;
function getTasksBase() {
  if (_tasksBase) return _tasksBase;
  _tasksBase = getConfig.orExit('TASKS_BASE');
  return _tasksBase;
}

// ─── Ticket context resolution ──────────────────────────────────────────────

let _cachedTicketId;
let _ticketIdResolved = false;

/**
 * Read the git HEAD ref for the cwd. Handles both worktrees (`.git` is a file
 * containing "gitdir: <path>") and normal repos (`.git` is a directory).
 */
function readGitHead() {
  let dotgit;
  try {
    dotgit = fs.readFileSync('.git', 'utf-8').trim();
  } catch {
    // .git is a directory (normal repo) — read HEAD directly
    return fs.readFileSync(path.join('.git', 'HEAD'), 'utf-8').trim();
  }
  if (dotgit.startsWith('gitdir: ')) {
    const gitdir = path.resolve(path.dirname('.git'), dotgit.slice('gitdir: '.length));
    return fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf-8').trim();
  }
  // unexpected .git content — fall back to the plain HEAD location
  return fs.readFileSync(path.join('.git', 'HEAD'), 'utf-8').trim();
}

function getTicketId() {
  if (_ticketIdResolved) return _cachedTicketId;
  _ticketIdResolved = true;
  if ('SESSION_GUARD_TICKET_ID' in process.env) {
    _cachedTicketId = process.env.SESSION_GUARD_TICKET_ID || null;
    return _cachedTicketId;
  }
  try {
    const head = readGitHead();
    const ref = head.startsWith('ref: ') ? head.slice(5) : head;
    const match = ref.match(/[A-Z]+-\d+/);
    _cachedTicketId = match ? match[0] : null;
  } catch {
    _cachedTicketId = null;
  }
  return _cachedTicketId;
}

/**
 * Resolve the session id that owns the current terminal.
 * Claude Code exports this as CLAUDE_CODE_SESSION_ID and passes the same value
 * as `session_id` in hook payloads, so the two are directly comparable.
 * AGENT_SESSION_ID is the runtime-neutral bridge set by hook processes for
 * their children (codex sets no CLAUDE_* vars).
 * Returns null when unavailable (e.g. plain CLI runs / older harness).
 */
function getOwnerSessionId() {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.AGENT_SESSION_ID || null;
}

/**
 * The session id of the terminal firing the current hook. Prefer the hook
 * payload's session_id (authoritative), falling back to the env vars.
 */
function currentSessionId(hookData) {
  return (
    hookData?.session_id ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    process.env.AGENT_SESSION_ID ||
    null
  );
}

/**
 * A session belongs to a DIFFERENT terminal when it carries an ownerSessionId
 * that we can compare against and that differs from the current session id.
 * Legacy sessions (no ownerSessionId) or an unknown current id are treated as
 * "not foreign" so existing ticket/cwd scoping still applies (backward compat).
 */
function isForeignSession(session, csid) {
  return Boolean(session?.ownerSessionId && csid && session.ownerSessionId !== csid);
}

/**
 * A session belongs to a DIFFERENT git worktree when it carries a worktreeRoot
 * we can compare against and that differs from the current worktree root.
 * Legacy sessions (no worktreeRoot) or an unresolvable current root are treated
 * as "not foreign" so existing ticket/cwd scoping still applies (backward compat).
 */
function isForeignWorktree(session, currentRoot) {
  return Boolean(session?.worktreeRoot && currentRoot && session.worktreeRoot !== currentRoot);
}

/**
 * True when a session is owned by a different terminal OR a different worktree —
 * i.e. it must not hold the current Stop/PreCompact hook. Each signal closes a
 * distinct failure mode: session id handles two sessions sharing one cwd;
 * worktree root handles sibling ticket worktrees whose branch names don't encode
 * a parseable ticket.
 */
function isOtherOwner(session, csid, currentRoot) {
  return isForeignSession(session, csid) || isForeignWorktree(session, currentRoot);
}

/** Best-effort safeTicketId — falls back to the raw id when config is unavailable. */
function safeTicketIdOrRaw(ticketId) {
  try {
    return require(path.join(__dirname, '..', '..', 'config')).safeTicketId(ticketId);
  } catch {
    return ticketId; /* use raw */
  }
}

/**
 * Read a per-ticket artifact file (`$TASKS_BASE/<ticket>/<fileName>`) as a
 * string. Returns null when TASKS_BASE is unset, the ticket is missing, or the
 * file is unreadable — callers treat that as "state unknown" and fail safe.
 */
function readTicketArtifact(ticketId, fileName) {
  try {
    const tasksBase = getConfig('TASKS_BASE');
    if (!tasksBase || !ticketId) return null;
    const safeId = safeTicketIdOrRaw(ticketId);
    return fs.readFileSync(path.join(tasksBase, safeId, fileName), 'utf8');
  } catch {
    return null;
  }
}

/** Map a 1-based step index from .work-state.json to its step name, or undefined. */
function stepNameFromIndex(stepIndex) {
  try {
    const { STEP_ORDER } = require(path.join(__dirname, '..', '..', '..', 'work', 'step-registry'));
    // currentStep in .work-state.json is 1-based (see work-state.js: stepIndex + 1)
    const zeroBasedIndex = stepIndex - 1;
    if (zeroBasedIndex >= 0 && zeroBasedIndex < STEP_ORDER.length) {
      return STEP_ORDER[zeroBasedIndex];
    }
  } catch {
    /* step-registry not available — stepName stays undefined */
  }
  return undefined;
}

/**
 * Read the /work workflow state for a ticket to determine the current step.
 * Returns { stepName, ticketId } or null on any failure.
 */
function readWorkState(ticketId) {
  try {
    const tasksBase = getTasksBase();
    if (!tasksBase) return null;

    const safeId = safeTicketIdOrRaw(ticketId);
    const resolved = path.resolve(tasksBase, safeId, '.work-state.json');
    // Guard against path traversal
    if (!resolved.startsWith(path.resolve(tasksBase) + path.sep)) return null;

    const state = JSON.parse(fs.readFileSync(resolved, 'utf-8'));
    const stepIndex = state?.currentStep;
    if (typeof stepIndex !== 'number') return null;

    const stepName = stepNameFromIndex(stepIndex);
    if (!stepName) return null;
    return { stepName, ticketId };
  } catch {
    return null;
  }
}

/** True when a /check state file marks the workflow as currently running. */
function hasActiveCheckState(resolvedBase, stateName) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(resolvedBase, stateName), 'utf-8'));
    return Boolean(state?.status === 'in_progress' || state?.currentStep);
  } catch {
    return false; /* not found or corrupt */
  }
}

/**
 * Check if the /check workflow is actively running for a ticket.
 * When /check is active, the session guard should not block stops
 * because /check has its own quality gates and state management.
 */
function isCheckWorkflowActive(ticketId) {
  try {
    // Validate ticketId to prevent path traversal
    if (!ticketId || /[/\\:\0]/.test(ticketId)) return false;

    const tasksBase = getTasksBase();
    const resolvedBase = path.resolve(tasksBase, safeTicketIdOrRaw(ticketId));
    // Guard against path traversal — resolved path must stay under tasksBase
    if (!resolvedBase.startsWith(path.resolve(tasksBase) + path.sep)) return false;

    // Check the script-driven /check state file (fall back to the legacy
    // .check2-state.json name for in-flight tickets that predate the rename)
    return ['.check-state.json', '.check2-state.json'].some((stateName) =>
      hasActiveCheckState(resolvedBase, stateName)
    );
  } catch {
    return false;
  }
}

module.exports = {
  currentSessionId,
  getOwnerSessionId,
  getTicketId,
  isCheckWorkflowActive,
  isOtherOwner,
  readTicketArtifact,
  readWorkState,
};
