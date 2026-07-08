'use strict';

/**
 * session-conflict.js — active-session conflict detection for work-next.
 *
 * Once a session is bootstrapped, future invocations MUST use the same
 * canonical ticket ID. These helpers detect when the user-supplied ticket
 * canonical conflicts with an existing active session on disk.
 */

const fs = require('fs');
const path = require('path');

/**
 * Normalize a ticket base the same way getNextInstruction does, so the
 * filesystem path we probe matches the one used by state writers.
 * For GitHub, `GH-56` / `56` / `#56` all canonicalize to `#56` before
 * sanitization → `sanitizeTicketIdForPath('#56', ...)` (e.g. `GH-56`).
 */
function normalizeTicketBase(ticketBase, providerConfig) {
  const isGitHub = providerConfig?.provider === 'github';
  if (isGitHub && (/^#?\d+$/.test(ticketBase) || /^GH-\d+$/i.test(ticketBase))) {
    const num = ticketBase.replace(/^#|^GH-/i, '');
    return '#' + num;
  }
  return ticketBase.toUpperCase();
}

/**
 * Read the existing session's recorded separator (if any) so the
 * `canonical` and `reason` fields are mutually consistent — matching the
 * form the session was originally created with. Falls back to `-`
 * (default re-invocation form).
 */
function readSessionSeparator(stateFile) {
  try {
    const raw = fs.readFileSync(stateFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && (parsed.ticketSeparator === '-' || parsed.ticketSeparator === '/')) {
      return parsed.ticketSeparator;
    }
  } catch {
    // ignore — fall back to '-'
  }
  return '-';
}

/** Find any suffix-session under tasks/<base>/ and describe the conflict. */
function findSuffixSessionConflict(baseDir, safeBase) {
  let entries;
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const stateFile = path.join(baseDir, entry.name, '.work-state.json');
    if (!fs.existsSync(stateFile)) continue;
    const existingSeparator = readSessionSeparator(stateFile);
    const canonical = `${safeBase}${existingSeparator}${entry.name}`;
    return {
      canonical,
      reason: `An active session exists for ${canonical}. Re-invoke with: ${canonical}`,
    };
  }
  return null;
}

/**
 * Detect whether the user-supplied ticket canonical conflicts with an existing
 * active session. Returns null on no conflict, or { canonical, reason } when
 * the caller should be blocked.
 *
 * Rules:
 *   - Input has suffix, no-suffix sibling state exists at tasks/<base>/.work-state.json → conflict
 *   - Input has no suffix, but a suffix-session exists at tasks/<base>/<suffix>/.work-state.json → conflict
 *   - Exact-match state (or no state at all) → no conflict
 */
function detectSessionConflict(validated, tasksBase, tp) {
  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  const normalizedBase = normalizeTicketBase(validated.ticketBase, providerConfig);
  const safeBase = tp.sanitizeTicketIdForPath(normalizedBase, providerConfig);
  const suffix = validated.suffix;
  const exactPath = path.join(
    tasksBase,
    suffix ? `${safeBase}/${suffix}` : safeBase,
    '.work-state.json'
  );
  if (fs.existsSync(exactPath)) return null; // exact match — proceed
  if (suffix) {
    // Input has suffix; check for a bare-base session
    const baseStatePath = path.join(tasksBase, safeBase, '.work-state.json');
    if (fs.existsSync(baseStatePath)) {
      return {
        canonical: safeBase,
        reason: `An active session exists for ${safeBase} (no suffix). Re-invoke with that exact canonical, or finish/abort it first.`,
      };
    }
    return null;
  }
  // Input has no suffix; check for any suffix-session under tasks/<base>/
  const baseDir = path.join(tasksBase, safeBase);
  if (!fs.existsSync(baseDir)) return null;
  return findSuffixSessionConflict(baseDir, safeBase);
}

module.exports = { detectSessionConflict, normalizeTicketBase };
