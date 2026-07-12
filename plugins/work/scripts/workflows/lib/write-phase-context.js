/**
 * Shared phase-context snapshot writer.
 *
 * Phase runners snapshot their computed inputs into `<name>-context.json`
 * inside the ticket's tasks dir for downstream phases (work-task-review
 * diff_audit, work-reports collect_artifacts). The write is advisory —
 * hooks may gate it — so failures are swallowed.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Write `<fileName>` into tasksDir with the shared bookkeeping fields.
 * @param {string} tasksDir - Ticket tasks directory
 * @param {string} fileName - Snapshot file name (e.g. 'reports-context.json')
 * @param {string[]} files - File list recorded as `files` + `fileCount`
 * @param {Object} [extra] - Leading payload fields (ticket, base, head, ...)
 */
function writePhaseContext(tasksDir, fileName, files, extra = {}) {
  const payload = {
    ...extra,
    fileCount: files.length,
    files,
    capturedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(path.join(tasksDir, fileName), JSON.stringify(payload, null, 2));
  } catch {
    /* hook-gated; non-fatal */
  }
}

module.exports = { writePhaseContext };
