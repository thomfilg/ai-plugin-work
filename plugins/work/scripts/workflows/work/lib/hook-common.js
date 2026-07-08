/**
 * hook-common.js — shared plumbing for /work PostToolUse hooks
 * (work-auto-advance.js, capture-usage.js).
 *
 * Extracted so each hook keeps only its own behavior: stdin parsing, runtime
 * normalization, and the session/worktree-scoped `.work.pid` marker lookup
 * are identical across hooks and must stay identical — a divergence here is
 * how cross-wiring bugs start.
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

module.exports = { installFailOpen, readHookData, normalizePostToolEvent, findRecentWorkMarker };
