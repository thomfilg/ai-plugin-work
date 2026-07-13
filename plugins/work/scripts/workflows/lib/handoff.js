/**
 * handoff.js — the `.continue-here.md` narrative-handoff module (GH-315).
 *
 * The narrative half of /work pause/resume: a durable, human-authored
 * `.continue-here.md` file with three REQUIRED level-2 headings that survives
 * session death and compaction. This module owns the handoff FORMAT
 * (`validateHandoffSections`) plus thin write/read/delete wrappers over the
 * per-ticket artifact helpers in `session-guard/context.js`.
 *
 * Design notes:
 *  - `validateHandoffSections` mirrors the `^##\s+<name>` `hasSection` regex
 *    from `work-spec/lib/phases/draft.js` (case-insensitive, line-anchored).
 *    It is a PURE function so hooks can validate section presence without any
 *    filesystem access or prose generation (R14).
 *  - `writeHandoff` validates BEFORE writing and refuses a skeleton, throwing
 *    an error that names the missing headings so a CLI caller cannot silently
 *    persist an empty handoff (R7). The pure validate path stays reusable by
 *    hooks that only want the `{ ok, missing }` shape.
 *
 * CommonJS, zero runtime dependency, tested with `node:test`.
 */

'use strict';

const path = require('path');

const { writeTicketArtifact, readTicketArtifact, deleteTicketArtifact } = require(
  path.join(__dirname, 'hooks', 'session-guard', 'context.js')
);

/**
 * The single canonical per-ticket handoff filename, resolved under
 * `$TASKS_BASE/<TICKET>/`. Kept as one shared constant so every read/write/
 * delete path agrees on the artifact name.
 * @type {string}
 */
const HANDOFF_FILENAME = '.continue-here.md';

/**
 * The three REQUIRED level-2 headings a valid `.continue-here.md` must carry,
 * in the order they should appear. `validateHandoffSections` reports any that
 * are absent, by name.
 * @type {readonly string[]}
 */
const REQUIRED_HANDOFF_SECTIONS = Object.freeze([
  'Decisions made (and why)',
  'Blockers / warnings',
  'What was in flight',
]);

/**
 * True when `text` contains a line-anchored `## <name>` markdown heading.
 * Mirrors `hasSection` from `work-spec/lib/phases/draft.js:32`: the heading
 * name is regex-escaped, matched case-insensitively (`i`) and per-line (`m`),
 * and must be followed by whitespace or end-of-line so `## Goalpost` does not
 * satisfy `## Goal`.
 *
 * @param {string} text markdown body to scan
 * @param {string} name required heading name (matched verbatim, minus `## `)
 * @returns {boolean}
 */
function hasSection(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^##\\s+${escaped}(?=\\s|$)`, 'im');
  return re.test(text);
}

/**
 * Validate that a handoff body carries every required heading.
 *
 * @param {string} text the `.continue-here.md` body
 * @returns {{ ok: boolean, missing: string[] }} `ok` is true only when no
 *   required heading is missing; `missing` lists every absent heading by name,
 *   in `REQUIRED_HANDOFF_SECTIONS` order.
 */
function validateHandoffSections(text) {
  const body = typeof text === 'string' ? text : '';
  const missing = REQUIRED_HANDOFF_SECTIONS.filter((name) => !hasSection(body, name));
  return { ok: missing.length === 0, missing };
}

/**
 * Validate then write the handoff to `$TASKS_BASE/<ticketId>/.continue-here.md`.
 * Refuses a skeleton: when a required heading is missing, nothing is written
 * and an Error naming the missing headings is thrown so the caller (a CLI
 * pause flow) surfaces the gap rather than persisting an empty handoff.
 *
 * @param {string} ticketId sanitized per-ticket id (e.g. `GH-315`)
 * @param {string} content the handoff markdown body
 * @returns {string} the absolute path of the written `.continue-here.md`
 * @throws {Error} when validation fails, or when the artifact write fails
 *   (e.g. TASKS_BASE unset / traversal id) — a null write is surfaced, never
 *   swallowed.
 */
function writeHandoff(ticketId, content) {
  const { ok, missing } = validateHandoffSections(content);
  if (!ok) {
    throw new Error(
      `Refusing to write ${HANDOFF_FILENAME}: missing required section(s): ${missing.join(', ')}.`
    );
  }
  const written = writeTicketArtifact(ticketId, HANDOFF_FILENAME, content);
  if (written === null) {
    throw new Error(
      `Failed to write ${HANDOFF_FILENAME} for ticket "${ticketId}" (unset TASKS_BASE or invalid ticket id).`
    );
  }
  return written;
}

/**
 * Read the handoff for a ticket.
 *
 * @param {string} ticketId sanitized per-ticket id
 * @returns {string|null} the `.continue-here.md` content, or null when absent.
 */
function readHandoff(ticketId) {
  return readTicketArtifact(ticketId, HANDOFF_FILENAME);
}

/**
 * Delete the handoff for a ticket (clear-after-resume).
 *
 * @param {string} ticketId sanitized per-ticket id
 * @returns {boolean} true when a handoff was removed, false when there was
 *   nothing to delete.
 */
function deleteHandoff(ticketId) {
  return deleteTicketArtifact(ticketId, HANDOFF_FILENAME);
}

module.exports = {
  HANDOFF_FILENAME,
  REQUIRED_HANDOFF_SECTIONS,
  validateHandoffSections,
  writeHandoff,
  readHandoff,
  deleteHandoff,
};
