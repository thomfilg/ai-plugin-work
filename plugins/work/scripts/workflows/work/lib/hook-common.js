/**
 * hook-common.js — shared plumbing for /work PostToolUse hooks
 * (work-auto-advance.js, capture-usage.js, context-monitor.js).
 *
 * Extracted so each hook keeps only its own behavior: stdin parsing, runtime
 * normalization, the session/worktree-scoped `.work.pid` marker lookup, and the
 * `.work-state.json` → active-step resolution are identical across hooks and
 * must stay identical — a divergence here is how cross-wiring bugs start.
 */

const fs = require('fs');
const path = require('path');

const MAX_MARKER_AGE_MS = 12 * 60 * 60 * 1000;

/** Fail-open: hooks must never break the session — any escape exits 0. */
function installFailOpen() {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
}

/** Parse hook input JSON from stdin; null on any failure (caller exits 0). */
function readHookData() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Resolve the runtime adapter and the canonical PostToolUse event for a raw
 * hook payload.
 * @returns {{rt: object, evt: object}}
 */
function normalizePostToolEvent(hookData) {
  const { getRuntime } = require(path.join(__dirname, '..', '..', 'lib', 'runtime'));
  const rt = getRuntime(hookData);
  const evt = rt.normalizeHookPayload(hookData, { event: 'PostToolUse' });
  return { rt, evt };
}

/**
 * Find this terminal's active /work session marker (recent, owned).
 * findActiveMarker scopes by owning session id + worktree root, so a hook
 * firing in one agent never acts on another agent's workflow (cross-wiring).
 * Markers older than 12 hours are treated as stale.
 *
 * @returns {{marker: object, tasksBase: string} | null}
 */
function findRecentWorkMarker() {
  const { resolvePluginConfig } = require(path.join(__dirname, '..', '..', 'lib', 'plugin-config'));
  const { TASKS_BASE } = resolvePluginConfig(path.resolve(__dirname, '..'));
  if (!TASKS_BASE) return null;

  const { findActiveMarker } = require(path.join(__dirname, 'marker'));
  const marker = findActiveMarker(TASKS_BASE, '.work.pid');
  if (!marker) return null;

  const markerAge = Date.now() - new Date(marker.startedAt).getTime();
  if (markerAge > MAX_MARKER_AGE_MS) return null;

  return { marker, tasksBase: TASKS_BASE };
}

/**
 * Resolve a ticket's active step name from its `.work-state.json`.
 *
 * `currentStep` is 1-indexed into ALL_STEPS (mirrors print-current-step.js).
 * The ticket id is sanitized via `lib/config` `safeTicketId` (traversal-safe),
 * falling back to the raw id if that lookup fails. A missing/corrupt state file
 * — or any other failure — yields `'unknown'` rather than dropping the caller's
 * record, so usage attribution and context warnings never break a workflow.
 *
 * @param {string} tasksBase Absolute TASKS_BASE root.
 * @param {string} ticket Raw ticket id.
 * @returns {string} The active step name, or `'unknown'`.
 */
function readStateStep(tasksBase, ticket) {
  let safe = ticket;
  try {
    safe = require(path.join(__dirname, '..', '..', 'lib', 'config')).safeTicketId(ticket);
  } catch {
    /* fall back to the raw id */
  }
  try {
    const statePath = path.join(tasksBase, safe, '.work-state.json');
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const { ALL_STEPS } = require(path.join(__dirname, '..', 'step-registry'));
    const num = Number(state && state.currentStep);
    if (Number.isFinite(num) && num >= 1 && num <= ALL_STEPS.length) {
      return ALL_STEPS[num - 1];
    }
  } catch {
    /* missing/corrupt state file */
  }
  return 'unknown';
}

module.exports = {
  installFailOpen,
  readHookData,
  normalizePostToolEvent,
  findRecentWorkMarker,
  readStateStep,
};
