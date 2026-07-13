/**
 * Tests for writeTicketArtifact + deleteTicketArtifact in session-guard/context.js.
 *
 * Task 1 (GH-315): these helpers sit beside readTicketArtifact and must:
 *  - write $TASKS_BASE/<safeId>/<file> and return the written path;
 *  - round-trip content with readTicketArtifact;
 *  - delete an existing file (return true) and no-op-return false on a missing
 *    file (never throw);
 *  - reuse the safeTicketIdOrRaw + startsWith(resolve(tasksBase) + sep)
 *    traversal guard so a `../`-style ticket id never writes outside the base;
 *  - fail-open (null / false) when TASKS_BASE is unset or the id is empty.
 *
 * node:test + node:assert/strict; isolated TASKS_BASE via fs.mkdtempSync.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = path.join(__dirname, '..', 'context.js');

let TASKS_BASE;
let prevTasksBase;
let prevWorktreesBase;

function loadModuleFresh() {
  // context.js caches TASKS_BASE via getConfig; drop the require cache so each
  // test observes the temp TASKS_BASE.
  delete require.cache[require.resolve(MODULE_PATH)];
  return require(MODULE_PATH);
}

beforeEach(() => {
  TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'context-artifact-'));
  prevTasksBase = process.env.TASKS_BASE;
  prevWorktreesBase = process.env.WORKTREES_BASE;
  process.env.TASKS_BASE = TASKS_BASE;
  process.env.WORKTREES_BASE = TASKS_BASE;
});

afterEach(() => {
  if (prevTasksBase === undefined) delete process.env.TASKS_BASE;
  else process.env.TASKS_BASE = prevTasksBase;
  if (prevWorktreesBase === undefined) delete process.env.WORKTREES_BASE;
  else process.env.WORKTREES_BASE = prevWorktreesBase;
  fs.rmSync(TASKS_BASE, { recursive: true, force: true });
});

describe('context.js → writeTicketArtifact / deleteTicketArtifact', () => {
  it('exports writeTicketArtifact and deleteTicketArtifact as functions', () => {
    const mod = loadModuleFresh();
    assert.equal(
      typeof mod.writeTicketArtifact,
      'function',
      'writeTicketArtifact must be exported from context.js'
    );
    assert.equal(
      typeof mod.deleteTicketArtifact,
      'function',
      'deleteTicketArtifact must be exported from context.js'
    );
  });

  it('writeTicketArtifact creates $TASKS_BASE/<safeId>/<file> and returns its path', () => {
    const { writeTicketArtifact } = loadModuleFresh();
    const written = writeTicketArtifact('GH-315', '.continue-here.md', 'hello world');

    const expected = path.join(TASKS_BASE, 'GH-315', '.continue-here.md');
    assert.equal(written, expected, 'returns the absolute written path');
    assert.equal(fs.existsSync(expected), true, 'the artifact file exists on disk');
    assert.equal(fs.readFileSync(expected, 'utf8'), 'hello world', 'content is written verbatim');
  });

  it('round-trips content with readTicketArtifact', () => {
    const { writeTicketArtifact, readTicketArtifact } = loadModuleFresh();
    writeTicketArtifact('GH-315', '.continue-here.md', 'round-trip payload');

    assert.equal(
      readTicketArtifact('GH-315', '.continue-here.md'),
      'round-trip payload',
      'readTicketArtifact reads back exactly what writeTicketArtifact wrote'
    );
  });

  it('deleteTicketArtifact removes an existing file and returns true', () => {
    const { writeTicketArtifact, deleteTicketArtifact } = loadModuleFresh();
    const written = writeTicketArtifact('GH-315', '.continue-here.md', 'to be deleted');
    assert.equal(fs.existsSync(written), true, 'precondition: file exists');

    const result = deleteTicketArtifact('GH-315', '.continue-here.md');
    assert.equal(result, true, 'returns true when a file was removed');
    assert.equal(fs.existsSync(written), false, 'the file is gone after delete');
  });

  it('deleteTicketArtifact returns false for a missing file and never throws', () => {
    const { deleteTicketArtifact } = loadModuleFresh();
    let result;
    assert.doesNotThrow(() => {
      result = deleteTicketArtifact('GH-315', '.does-not-exist.md');
    }, 'deleting a missing file must not throw');
    assert.equal(result, false, 'returns false when there was nothing to delete');
  });

  it('refuses a `../`-style ticket id — writes nothing outside the tasks base', () => {
    const { writeTicketArtifact } = loadModuleFresh();
    const escapeTarget = path.resolve(TASKS_BASE, '..', 'evil', '.continue-here.md');

    const result = writeTicketArtifact('../evil', '.continue-here.md', 'pwned');

    assert.equal(result, null, 'a traversal ticket id yields null (refused)');
    assert.equal(
      fs.existsSync(escapeTarget),
      false,
      'nothing is written outside $TASKS_BASE for a `../`-style id'
    );
  });

  it('fails open (null / false) when TASKS_BASE is unset', () => {
    delete process.env.TASKS_BASE;
    delete process.env.WORKTREES_BASE;
    const { writeTicketArtifact, deleteTicketArtifact } = loadModuleFresh();

    assert.equal(
      writeTicketArtifact('GH-315', '.continue-here.md', 'x'),
      null,
      'writeTicketArtifact returns null with no TASKS_BASE'
    );
    assert.equal(
      deleteTicketArtifact('GH-315', '.continue-here.md'),
      false,
      'deleteTicketArtifact returns false with no TASKS_BASE'
    );
  });

  it('fails open (null / false) when the ticket id is empty', () => {
    const { writeTicketArtifact, deleteTicketArtifact } = loadModuleFresh();

    assert.equal(
      writeTicketArtifact('', '.continue-here.md', 'x'),
      null,
      'writeTicketArtifact returns null for an empty ticket id'
    );
    assert.equal(
      deleteTicketArtifact('', '.continue-here.md'),
      false,
      'deleteTicketArtifact returns false for an empty ticket id'
    );
  });
});
