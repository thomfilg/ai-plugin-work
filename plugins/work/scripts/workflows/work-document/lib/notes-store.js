/**
 * notes-store.js — the `document` step's receipt: what the agent recorded
 * about this ticket, and where it put it.
 *
 * The step's contract is "at least one real note was SAVED", and a sentinel
 * file (`touch .memorized`, the pattern the memorize phases use) cannot carry
 * that: it proves a `touch` ran, not that anything was written. So each note
 * records its sink and enough of its content for the gate to check something
 * real — with one honest limit: a memory-sink note is only as true as the
 * agent's claim that it called the tool, since nothing here can read another
 * plugin's store. The docs sink has no such gap, and is re-read at gate time:
 *
 *   memory sink → the plugin + tool that took it, plus the summary sent
 *   docs sink   → a path INSIDE the ticket worktree, which must still exist
 *                 and still hold substance when the gate reads it
 *
 * A docs note is therefore re-verified against the filesystem at gate time: a
 * file deleted or emptied after the fact fails the step, which a sentinel
 * would happily pass.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const NOTES_FILE = '.document-notes.json';

/** A note has to say something. Shorter than this is a placeholder, not a note. */
const MIN_SUMMARY_CHARS = 80;
/** A docs note's file has to hold the note, not just its heading. */
const MIN_DOC_CHARS = 200;

/** Summaries that clear the length bar by saying nothing. */
const PLACEHOLDER_RE = /^(?:n\/?a|none|nothing|todo|tbd|wip|no notes?|\.+|-+|_+|\s)*$/i;

const SINKS = Object.freeze({ memory: 'memory', docs: 'docs' });

function notesPath(tasksDir) {
  return path.join(tasksDir, NOTES_FILE);
}

/** Parsed notes for the ticket; [] when absent or unreadable (fail-closed). */
function readNotes(tasksDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(notesPath(tasksDir), 'utf8'));
    return Array.isArray(parsed?.notes) ? parsed.notes : [];
  } catch {
    return [];
  }
}

function writeNotes(tasksDir, ticket, notes) {
  fs.mkdirSync(tasksDir, { recursive: true });
  const body = JSON.stringify({ ticket, notes }, null, 2);
  fs.writeFileSync(notesPath(tasksDir), `${body}\n`);
}

/** Append `note` to the ticket's receipt and return every note now stored. */
function appendNote(tasksDir, ticket, note) {
  const notes = readNotes(tasksDir);
  notes.push({ ...note, at: note.at || new Date().toISOString() });
  writeNotes(tasksDir, ticket, notes);
  return notes;
}

function summaryIsSubstantial(summary) {
  const text = String(summary || '').trim();
  return text.length >= MIN_SUMMARY_CHARS && !PLACEHOLDER_RE.test(text);
}

/** `p` resolves to something at or under `root` (no `..` escape). */
function isInside(root, p) {
  const rel = path.relative(root, p);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Re-check a docs note against the filesystem: the file must still be inside
 * the worktree, still exist, and still hold at least MIN_DOC_CHARS.
 * `worktreeRoot` null (unresolvable worktree) drops only the containment
 * clause — existence and substance still have to hold.
 */
function docFileHolds(notePath, worktreeRoot) {
  if (!notePath) return false;
  const abs = path.resolve(notePath);
  if (worktreeRoot && !isInside(path.resolve(worktreeRoot), abs)) return false;
  try {
    return fs.readFileSync(abs, 'utf8').trim().length >= MIN_DOC_CHARS;
  } catch {
    return false;
  }
}

/** Is this one note valid on its own terms? */
function noteIsValid(note, worktreeRoot) {
  if (!note || !summaryIsSubstantial(note.summary)) return false;
  if (note.sink === SINKS.memory) return Boolean(note.memory && note.tool);
  if (note.sink === SINKS.docs) return docFileHolds(note.path, worktreeRoot);
  return false;
}

/**
 * The step's verdict.
 *
 * `memoryConfigured` decides which sink SATISFIES it, not merely which is
 * preferred: with a memory plugin configured the note belongs in the memory
 * system, and a docs file — however good — does not discharge that. Without
 * one, the worktree docs file is the only sink there is.
 *
 * @param {{notes: object[], memoryConfigured: boolean, worktreeRoot: ?string}} input
 * @returns {{ok: boolean, reason: string, valid: object[]}}
 */
function evaluateNotes({ notes, memoryConfigured, worktreeRoot }) {
  const valid = (notes || []).filter((n) => noteIsValid(n, worktreeRoot));
  if (valid.length === 0) {
    return { ok: false, reason: reasonForNoValidNote(notes, memoryConfigured), valid };
  }
  const required = memoryConfigured ? SINKS.memory : SINKS.docs;
  if (!valid.some((n) => n.sink === required)) {
    return {
      ok: false,
      reason: memoryConfigured
        ? 'a memory plugin is configured, so at least one note must be saved THROUGH it ' +
          '(the recorded notes only reach worktree docs)'
        : 'no memory plugin is configured, so at least one note must be written to the ' +
          'ticket worktree docs (the recorded notes claim a memory sink that does not exist here)',
      valid,
    };
  }
  return { ok: true, reason: '', valid };
}

function reasonForNoValidNote(notes, memoryConfigured) {
  const where = memoryConfigured
    ? 'the configured memory plugin'
    : 'a docs file in the ticket worktree';
  if (!notes || notes.length === 0) {
    return `no note recorded — save at least one note about this ticket's work to ${where}`;
  }
  return (
    `${notes.length} note(s) recorded but none valid — a note needs a summary of at least ` +
    `${MIN_SUMMARY_CHARS} substantive characters, and a docs note needs its file to still ` +
    `exist under the worktree with at least ${MIN_DOC_CHARS} characters`
  );
}

module.exports = {
  NOTES_FILE,
  MIN_SUMMARY_CHARS,
  MIN_DOC_CHARS,
  SINKS,
  notesPath,
  readNotes,
  appendNote,
  evaluateNotes,
  noteIsValid,
  summaryIsSubstantial,
};
