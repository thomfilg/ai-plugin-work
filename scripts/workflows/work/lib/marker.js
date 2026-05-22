/**
 * Marker file management for /work session detection.
 *
 * The marker file (.work.pid) enables hooks to detect
 * active /work sessions without relying on session_id matching.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Write marker file to tasks directory for session detection.
 * @param {string} ticket - Raw ticket ID
 * @param {string} sessionId - Session identifier
 * @param {object} deps - { TASKS_BASE, tp }
 */
function writeMarkerFile(ticket, sessionId, deps) {
  const { TASKS_BASE, tp } = deps;
  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  const safeBase = tp.sanitizeTicketIdForPath(ticket.toUpperCase(), providerConfig);
  const tasksDir = path.join(TASKS_BASE, safeBase);
  try {
    fs.mkdirSync(tasksDir, { recursive: true });
    const markerPath = path.join(tasksDir, '.work.pid');
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ sessionId, ticket, startedAt: new Date().toISOString() })
    );
  } catch {
    /* fail-open */
  }
}

module.exports = { writeMarkerFile };
