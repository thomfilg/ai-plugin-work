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

/**
 * A note has to say something. This is the SUBSTANTIVE length — filler words
 * and padding do not count toward it — so the CLI's "at least 80 substantive
 * characters" is literal, not an approximation.
 */
const MIN_SUMMARY_CHARS = 80;
/** A docs note's file has to hold the note, not just its heading. */
const MIN_DOC_CHARS = 200;

/**
 * Filler words that say nothing, and the punctuation used to pad around them.
 *
 * Written as two linear passes rather than one alternation under a `*`. The
 * obvious form — `/^(?:none|todo|\.+|-+|\s)*$/` — nests a quantifier inside a
 * quantified group, so a run of N dashes has exponentially many ways to be
 * split between the outer `*` and the inner `+`. CodeQL flagged it and a
 * 29-character summary hung the check for minutes. This regex is reachable
 * from agent-authored text, so that is a gate an agent can wedge by accident.
 */
const PLACEHOLDER_WORDS = /\b(?:n\/?a|none|nothing|todo|tbd|wip|no notes?)\b/gi;
const PADDING_CHARS = /[.\-_\s]/g;

/**
 * How much of `text` is actually saying something: length after filler words
 * and padding are removed.
 *
 * Measuring AFTER the strip, rather than testing "is it ALL padding", closes
 * the gap a first cut left open: 5000 dashes and a single `x` is not all
 * padding, and would have cleared a whole-string placeholder test.
 */
function substanceOf(text) {
  return text.replace(PLACEHOLDER_WORDS, '').replace(PADDING_CHARS, '').length;
}

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
  return substanceOf(String(summary || '').trim()) >= MIN_SUMMARY_CHARS;
}

/** `p` resolves to something at or under `root` (no `..` escape). */
function isInside(root, p) {
  const rel = path.relative(root, p);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Where a docs note is allowed to live: the ticket's worktree, or — when that
 * cannot be resolved — the ticket's tasks dir. Never nowhere.
 *
 * An earlier cut dropped the containment clause entirely on an unresolvable
 * worktree, on the theory that existence and substance still held. They do,
 * but of the WRONG file: `/etc/services` is readable and long, and it
 * satisfied the gate. The point of this step is that the note is somewhere a
 * later run will look, so an unresolvable worktree narrows the target rather
 * than removing it.
 */
function allowedRoots({ worktreeRoot, tasksDir }) {
  return [worktreeRoot, tasksDir].filter(Boolean).map((r) => path.resolve(r));
}

/**
 * Re-check a docs note against the filesystem: the file must sit under one of
 * the allowed roots, still exist, and still hold at least MIN_DOC_CHARS.
 * No resolvable root at all → false: nothing can be proven, and this step runs
 * pre-merge where a refusal costs only a re-run.
 */
function docFileHolds(notePath, roots) {
  if (!notePath || roots.length === 0) return false;
  const abs = path.resolve(notePath);
  if (!roots.some((root) => isInside(root, abs))) return false;
  try {
    return fs.readFileSync(abs, 'utf8').trim().length >= MIN_DOC_CHARS;
  } catch {
    return false;
  }
}

/** Is this one note valid on its own terms? */
function noteIsValid(note, roots) {
  if (!note || !summaryIsSubstantial(note.summary)) return false;
  if (note.sink === SINKS.memory) return Boolean(note.memory && note.tool);
  if (note.sink === SINKS.docs) return docFileHolds(note.path, roots);
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
 * @param {{notes: object[], memoryConfigured: boolean, worktreeRoot: ?string,
 *          tasksDir: ?string}} input
 * @returns {{ok: boolean, reason: string, valid: object[]}}
 */
function evaluateNotes({ notes, memoryConfigured, worktreeRoot, tasksDir }) {
  const roots = allowedRoots({ worktreeRoot, tasksDir });
  const valid = (notes || []).filter((n) => noteIsValid(n, roots));
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
    `exist under the ticket worktree (or its tasks dir) with at least ${MIN_DOC_CHARS} characters`
  );
}

module.exports = {
  NOTES_FILE,
  MIN_SUMMARY_CHARS,
  MIN_DOC_CHARS,
  SINKS,
  allowedRoots,
  notesPath,
  readNotes,
  appendNote,
  evaluateNotes,
  noteIsValid,
  summaryIsSubstantial,
};
