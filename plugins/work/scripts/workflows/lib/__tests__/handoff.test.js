/**
 * Tests for handoff.js — the `.continue-here.md` narrative-handoff module (GH-315, Task 2).
 *
 * handoff.js exposes:
 *  - REQUIRED_HANDOFF_SECTIONS — the three required level-2 headings;
 *  - validateHandoffSections(text) -> { ok, missing[] } — mirrors the
 *    `^##\s+<name>` `hasSection` regex from work-spec/lib/phases/draft.js;
 *  - writeHandoff(ticketId, content) -> path — validates BEFORE writing via
 *    writeTicketArtifact; refuses a skeleton and surfaces the missing headings;
 *  - readHandoff(ticketId) -> string|null — delegates to readTicketArtifact;
 *  - deleteHandoff(ticketId) -> boolean — delegates to deleteTicketArtifact.
 *
 * node:test + node:assert/strict; isolated TASKS_BASE via fs.mkdtempSync.
 * The three required sections are:
 *   ## Decisions made (and why)
 *   ## Blockers / warnings
 *   ## What was in flight
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_PATH = path.join(__dirname, '..', 'handoff.js');
const CONTEXT_PATH = path.join(__dirname, '..', 'hooks', 'session-guard', 'context.js');

// The canonical per-ticket handoff filename.
const HANDOFF_FILE = '.continue-here.md';

let TASKS_BASE;
let prevTasksBase;
let prevWorktreesBase;

/**
 * Load handoff.js fresh each test so it observes the temp TASKS_BASE.
 *
 * Drops the require cache for handoff.js AND its context.js dependency
 * (context.js caches TASKS_BASE via getConfig, so it must be reloaded too).
 *
 * While handoff.js does not yet exist (RED phase), a raw `require` of a
 * missing module would emit a top-level module-resolution error that the RED
 * validator treats as a structural load failure rather than a behavior gap.
 * We convert that specific "module absent" case into a clean assertion
 * failure so the suite loads, collects its tests, and each test fails on a
 * real expectation — exactly the RED signal the gate wants.
 */
function loadModuleFresh() {
  let resolved;
  try {
    resolved = require.resolve(MODULE_PATH);
  } catch (err) {
    if (err && err.code === 'MODULE_NOT_FOUND') {
      assert.fail('handoff.js is not implemented yet (expected once GREEN lands)');
    }
    throw err;
  }
  delete require.cache[resolved];
  try {
    delete require.cache[require.resolve(CONTEXT_PATH)];
  } catch {
    /* context.js resolves once handoff.js requires it */
  }
  try {
    delete require.cache[require.resolve(path.join(__dirname, '..', 'hooks', 'get-config.js'))];
  } catch {
    /* get-config path may differ; env-based read still works */
  }
  return require(resolved);
}

/** A handoff body with all three required sections filled in. */
function validHandoff() {
  return [
    '# Continue Here — GH-315',
    '',
    '## Decisions made (and why)',
    'Chose to mirror hasSection for parity with the spec gate.',
    '',
    '## Blockers / warnings',
    'None; Task 1 helpers are already in place.',
    '',
    '## What was in flight',
    'Writing the handoff.js RED tests.',
    '',
  ].join('\n');
}

/** A skeleton missing the `## What was in flight` section. */
function skeletonMissingInFlight() {
  return [
    '# Continue Here — GH-315',
    '',
    '## Decisions made (and why)',
    'Placeholder.',
    '',
    '## Blockers / warnings',
    'Placeholder.',
    '',
  ].join('\n');
}

beforeEach(() => {
  TASKS_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-'));
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

describe('handoff.js → module surface', () => {
  it('exports REQUIRED_HANDOFF_SECTIONS and the validate/write/read/delete functions', () => {
    const mod = loadModuleFresh();
    assert.ok(
      Array.isArray(mod.REQUIRED_HANDOFF_SECTIONS),
      'REQUIRED_HANDOFF_SECTIONS must be an array'
    );
    assert.equal(typeof mod.validateHandoffSections, 'function', 'validateHandoffSections');
    assert.equal(typeof mod.writeHandoff, 'function', 'writeHandoff');
    assert.equal(typeof mod.readHandoff, 'function', 'readHandoff');
    assert.equal(typeof mod.deleteHandoff, 'function', 'deleteHandoff');
  });

  it('REQUIRED_HANDOFF_SECTIONS lists the three required handoff headings', () => {
    const { REQUIRED_HANDOFF_SECTIONS } = loadModuleFresh();
    assert.deepEqual(
      REQUIRED_HANDOFF_SECTIONS,
      ['Decisions made (and why)', 'Blockers / warnings', 'What was in flight'],
      'the three required section names, in order'
    );
  });
});

describe('handoff.js → validateHandoffSections', () => {
  it('a valid handoff with all three sections returns { ok: true, missing: [] }', () => {
    const { validateHandoffSections } = loadModuleFresh();
    const result = validateHandoffSections(validHandoff());
    assert.equal(result.ok, true, 'ok is true when every required heading is present');
    assert.deepEqual(result.missing, [], 'nothing is missing');
  });

  it('handoff validation rejects a skeleton missing a required section', () => {
    const { validateHandoffSections } = loadModuleFresh();
    const result = validateHandoffSections(skeletonMissingInFlight());
    assert.equal(result.ok, false, 'ok is false when a required heading is absent');
    assert.deepEqual(
      result.missing,
      ['What was in flight'],
      'the single missing heading is surfaced by name'
    );
  });

  it('lists every absent heading when multiple sections are missing', () => {
    const { validateHandoffSections } = loadModuleFresh();
    const result = validateHandoffSections('## Decisions made (and why)\nonly one section\n');
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.missing,
      ['Blockers / warnings', 'What was in flight'],
      'both remaining headings are reported'
    );
  });

  it('matches headings case-insensitively at line start', () => {
    const { validateHandoffSections } = loadModuleFresh();
    const lowercased = validHandoff().toLowerCase();
    const result = validateHandoffSections(lowercased);
    assert.equal(result.ok, true, 'lowercase headings still satisfy validation');
    assert.deepEqual(result.missing, []);
  });

  it('tolerates prose between the required headings', () => {
    const { validateHandoffSections } = loadModuleFresh();
    const body = [
      'preamble prose before any heading',
      '## Decisions made (and why)',
      'lots of explanatory prose here',
      'more prose',
      '## Blockers / warnings',
      'a warning paragraph',
      '## What was in flight',
      'trailing prose',
    ].join('\n');
    const result = validateHandoffSections(body);
    assert.equal(result.ok, true, 'prose interleaved with headings does not break detection');
    assert.deepEqual(result.missing, []);
  });

  it('does not match a heading that is not line-anchored (## in mid-line)', () => {
    const { validateHandoffSections } = loadModuleFresh();
    const body = [
      'see the ## Decisions made (and why) note inline',
      '## Blockers / warnings',
      '## What was in flight',
    ].join('\n');
    const result = validateHandoffSections(body);
    assert.equal(result.ok, false, 'an inline (non-anchored) heading is not counted');
    assert.deepEqual(result.missing, ['Decisions made (and why)']);
  });
});

describe('handoff.js → writeHandoff / readHandoff / deleteHandoff', () => {
  it('pause-work authors a valid handoff with all three sections', () => {
    const { writeHandoff } = loadModuleFresh();
    const written = writeHandoff('GH-315', validHandoff());

    const expected = path.join(TASKS_BASE, 'GH-315', HANDOFF_FILE);
    assert.equal(written, expected, 'writeHandoff returns the absolute .continue-here.md path');
    assert.equal(fs.existsSync(expected), true, 'the handoff file exists on disk');
    assert.equal(
      fs.readFileSync(expected, 'utf8'),
      validHandoff(),
      'the handoff content is written verbatim'
    );
  });

  it('writeHandoff refuses a skeleton: writes nothing and surfaces the missing headings', () => {
    const { writeHandoff } = loadModuleFresh();
    const target = path.join(TASKS_BASE, 'GH-315', HANDOFF_FILE);

    let surfaced = '';
    assert.throws(
      () => writeHandoff('GH-315', skeletonMissingInFlight()),
      (err) => {
        surfaced = String(err && err.message);
        return err instanceof Error;
      },
      'writeHandoff throws on a skeleton so the caller cannot silently persist it'
    );
    assert.match(surfaced, /What was in flight/, 'the error surfaces the missing heading by name');
    assert.equal(
      fs.existsSync(target),
      false,
      'nothing is written to .continue-here.md when validation fails'
    );
  });

  it('readHandoff round-trips the content that writeHandoff persisted', () => {
    const { writeHandoff, readHandoff } = loadModuleFresh();
    writeHandoff('GH-315', validHandoff());

    assert.equal(
      readHandoff('GH-315'),
      validHandoff(),
      'readHandoff reads back exactly what writeHandoff wrote'
    );
  });

  it('readHandoff returns null when no handoff exists', () => {
    const { readHandoff } = loadModuleFresh();
    assert.equal(
      readHandoff('GH-315'),
      null,
      'readHandoff returns null for an absent .continue-here.md'
    );
  });

  it('deleteHandoff removes the handoff (returns true) and readHandoff is then null', () => {
    const { writeHandoff, readHandoff, deleteHandoff } = loadModuleFresh();
    writeHandoff('GH-315', validHandoff());

    const removed = deleteHandoff('GH-315');
    assert.equal(removed, true, 'deleteHandoff returns true when a handoff was removed');
    assert.equal(readHandoff('GH-315'), null, 'the handoff is gone after delete');
  });

  it('deleteHandoff returns false when there is no handoff to remove', () => {
    const { deleteHandoff } = loadModuleFresh();
    assert.equal(
      deleteHandoff('GH-315'),
      false,
      'deleteHandoff returns false when nothing was deleted'
    );
  });
});
