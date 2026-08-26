/**
 * Unit tests for the document step's receipt.
 *
 * The point of this store is that it cannot be satisfied by a gesture. Each
 * test below is a way an agent could otherwise "complete" the step without
 * recording anything: an empty summary, a placeholder, a memory note when no
 * memory plugin exists, a docs note whose file was deleted afterwards.
 *
 * Run: node --test scripts/workflows/work-document/__tests__/notes-store.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MIN_SUMMARY_CHARS,
  MIN_DOC_CHARS,
  SINKS,
  readNotes,
  appendNote,
  evaluateNotes,
  summaryIsSubstantial,
} = require('../lib/notes-store');

const GOOD_SUMMARY =
  'Reworked the cache key to include the shard index; the old key collided across ' +
  'shards and the failure only showed up under parallel CI, never locally.';

let root;
let tasksDir;
let worktree;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-store-'));
  tasksDir = path.join(root, 'tasks', 'GH-800');
  worktree = path.join(root, 'wt');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeDoc(relPath, chars = MIN_DOC_CHARS + 20) {
  const file = path.join(worktree, relPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x'.repeat(chars));
  return file;
}

const evaluate = (notes, memoryConfigured) =>
  evaluateNotes({ notes, memoryConfigured, worktreeRoot: worktree });

describe('summaryIsSubstantial', () => {
  it('rejects a summary that is too short to say anything', () => {
    assert.equal(summaryIsSubstantial('fixed it'), false);
    assert.equal(summaryIsSubstantial('x'.repeat(MIN_SUMMARY_CHARS - 1)), false);
  });

  it('rejects padding that clears the length bar without saying anything', () => {
    assert.equal(summaryIsSubstantial('-'.repeat(MIN_SUMMARY_CHARS + 10)), false);
    assert.equal(summaryIsSubstantial(`n/a ${'.'.repeat(MIN_SUMMARY_CHARS)}`), false);
    assert.equal(summaryIsSubstantial(' '.repeat(MIN_SUMMARY_CHARS + 5)), false);
  });

  it('accepts a real note', () => {
    assert.equal(summaryIsSubstantial(GOOD_SUMMARY), true);
  });

  it('stays linear on adversarial padding (CodeQL: no catastrophic backtracking)', () => {
    // The first cut alternated `\.+|-+|_+` inside a `*` group. A 29-char
    // summary of dashes then hung the check for minutes — and this runs on
    // agent-authored text, so an agent could wedge its own gate by accident.
    // 5000 padding chars must be answered instantly, not eventually.
    for (const pad of ['-', '.', '_', ' ']) {
      const started = Date.now();
      assert.equal(summaryIsSubstantial(pad.repeat(5000)), false);
      // Padding + one real character: not ALL padding, but 1 substantive char.
      assert.equal(summaryIsSubstantial(`${pad.repeat(5000)}x`), false);
      assert.ok(
        Date.now() - started < 1000,
        `padding with "${pad}" took ${Date.now() - started}ms — backtracking is back`
      );
    }
  });

  it('still sees a real note buried in padding', () => {
    assert.equal(summaryIsSubstantial(`--- ${GOOD_SUMMARY} ---`), true);
  });
});

describe('evaluateNotes — nothing recorded', () => {
  it('fails on an empty receipt and says where the note belongs', () => {
    const withMemory = evaluate([], true);
    assert.equal(withMemory.ok, false);
    assert.match(withMemory.reason, /configured memory plugin/);

    const withoutMemory = evaluate([], false);
    assert.equal(withoutMemory.ok, false);
    assert.match(withoutMemory.reason, /worktree/);
  });

  it('fails when notes exist but none are valid', () => {
    const verdict = evaluate(
      [{ sink: SINKS.memory, memory: 'cortex', tool: 't', summary: 'ok' }],
      true
    );
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /none valid/);
  });
});

describe('evaluateNotes — the sink is required, not preferred', () => {
  it('a memory plugin makes worktree docs insufficient on their own', () => {
    const notes = [
      { sink: SINKS.docs, path: writeDoc('docs/work-notes/GH-800.md'), summary: GOOD_SUMMARY },
    ];
    const verdict = evaluate(notes, true);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /saved THROUGH it/);
    assert.equal(verdict.valid.length, 1, 'the docs note is valid, just not sufficient');
  });

  it('no memory plugin makes a claimed memory note insufficient', () => {
    const notes = [
      { sink: SINKS.memory, memory: 'cortex', tool: 'remember', summary: GOOD_SUMMARY },
    ];
    const verdict = evaluate(notes, false);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /does not exist here/);
  });

  it('passes on the sink this machine actually has', () => {
    assert.equal(
      evaluate(
        [{ sink: SINKS.memory, memory: 'cortex', tool: 'remember', summary: GOOD_SUMMARY }],
        true
      ).ok,
      true
    );
    assert.equal(
      evaluate(
        [{ sink: SINKS.docs, path: writeDoc('docs/work-notes/GH-800.md'), summary: GOOD_SUMMARY }],
        false
      ).ok,
      true
    );
  });
});

describe('evaluateNotes — a docs note is re-read, not trusted', () => {
  it('fails when the file was deleted after it was recorded', () => {
    const file = writeDoc('docs/work-notes/GH-800.md');
    const notes = [{ sink: SINKS.docs, path: file, summary: GOOD_SUMMARY }];
    assert.equal(evaluate(notes, false).ok, true);
    fs.rmSync(file);
    assert.equal(evaluate(notes, false).ok, false, 'a deleted note must not still pass');
  });

  it('fails when the file was emptied after it was recorded', () => {
    const file = writeDoc('docs/work-notes/GH-800.md');
    const notes = [{ sink: SINKS.docs, path: file, summary: GOOD_SUMMARY }];
    fs.writeFileSync(file, 'x'.repeat(MIN_DOC_CHARS - 1));
    assert.equal(evaluate(notes, false).ok, false);
  });

  it('fails when the file is outside the ticket worktree', () => {
    // The note has to live with the ticket, not in /tmp where the next run
    // will never look for it.
    const outside = path.join(root, 'elsewhere.md');
    fs.writeFileSync(outside, 'x'.repeat(MIN_DOC_CHARS + 10));
    const notes = [{ sink: SINKS.docs, path: outside, summary: GOOD_SUMMARY }];
    assert.equal(evaluate(notes, false).ok, false);
  });

  it('still requires existence and substance when the worktree is unresolvable', () => {
    const file = writeDoc('docs/work-notes/GH-800.md');
    const notes = [{ sink: SINKS.docs, path: file, summary: GOOD_SUMMARY }];
    assert.equal(evaluateNotes({ notes, memoryConfigured: false, worktreeRoot: null }).ok, true);
    fs.rmSync(file);
    assert.equal(evaluateNotes({ notes, memoryConfigured: false, worktreeRoot: null }).ok, false);
  });
});

describe('appendNote / readNotes', () => {
  it('round-trips and stamps a timestamp', () => {
    assert.deepEqual(readNotes(tasksDir), []);
    const notes = appendNote(tasksDir, 'GH-800', {
      sink: SINKS.memory,
      memory: 'cortex',
      tool: 'remember',
      summary: GOOD_SUMMARY,
    });
    assert.equal(notes.length, 1);
    assert.ok(notes[0].at, 'note carries a timestamp');
    assert.deepEqual(readNotes(tasksDir), notes);
  });

  it('accumulates rather than overwriting', () => {
    appendNote(tasksDir, 'GH-800', { sink: SINKS.docs, path: 'a', summary: GOOD_SUMMARY });
    appendNote(tasksDir, 'GH-800', { sink: SINKS.docs, path: 'b', summary: GOOD_SUMMARY });
    assert.equal(readNotes(tasksDir).length, 2);
  });

  it('reads an unreadable or corrupt receipt as "nothing recorded"', () => {
    fs.writeFileSync(path.join(tasksDir, '.document-notes.json'), '{not json');
    assert.deepEqual(readNotes(tasksDir), []);
    assert.equal(evaluate(readNotes(tasksDir), false).ok, false);
  });
});
