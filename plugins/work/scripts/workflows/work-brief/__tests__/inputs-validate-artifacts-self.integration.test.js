'use strict';

/**
 * Integration test: validateArtifacts() rejects _related/<self>.md on disk.
 *
 * Background: the inputs phase asks the agent to save each LINKED ticket's
 * full description to `_related/<id>.md`. The current ticket itself
 * (`manifest.self.id`) must NEVER appear under `_related/` — that's a sign
 * the agent confused "self" with "linked" and dumped its own ticket body
 * into the siblings folder. validateArtifacts() must catch this and emit
 * an error referencing the offending path.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { validateArtifacts } = require('../lib/phases/inputs');

const SELF_ID = 'GH-415';
const LINKED_ID = 'GH-9001';
const VALID_BODY = 'x'.repeat(80); // satisfies the >=50 chars rule

function makeTasksDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'inputs-validate-self-'));
  const tasksDir = path.join(root, SELF_ID);
  fs.mkdirSync(path.join(tasksDir, '_related'), { recursive: true });
  return { root, tasksDir };
}

describe('inputs.validateArtifacts() — _related/<self>.md rejection', () => {
  let root;
  let tasksDir;

  before(() => {
    const made = makeTasksDir();
    root = made.root;
    tasksDir = made.tasksDir;
    // Linked ticket file (satisfies existing happy-path requirement).
    fs.writeFileSync(
      path.join(tasksDir, '_related', `${LINKED_ID}.md`),
      VALID_BODY
    );
    // Offending self-file inside _related/.
    fs.writeFileSync(
      path.join(tasksDir, '_related', `${SELF_ID}.md`),
      VALID_BODY
    );
  });

  after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns an error pointing at _related/<self>.md when the self ticket file is present', () => {
    const manifest = {
      self: { id: SELF_ID, title: 'Self ticket' },
      parent: null,
      siblings: [{ id: LINKED_ID, title: 'Linked sibling' }],
    };
    const errors = validateArtifacts(tasksDir, manifest, [LINKED_ID]);
    assert.ok(Array.isArray(errors), 'validateArtifacts must return an array');
    const offending = path.join(tasksDir, '_related', `${SELF_ID}.md`);
    const hit = errors.find(
      (e) => typeof e === 'string' && e.includes(`${SELF_ID}.md`) && e.includes('_related')
    );
    assert.ok(
      hit,
      `expected an error mentioning _related/${SELF_ID}.md, got: ${JSON.stringify(errors)}`
    );
    // Error should also reference the actual file path so the agent knows
    // exactly what to delete.
    assert.ok(
      errors.some((e) => e.includes(offending)),
      `expected error to include absolute offending path ${offending}, got: ${JSON.stringify(errors)}`
    );
  });

  it('catches _related/<self>.md even when linkedIds is empty (zero siblings)', () => {
    const isoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inputs-validate-self-zero-'));
    const isoTasksDir = path.join(isoRoot, SELF_ID);
    fs.mkdirSync(path.join(isoTasksDir, '_related'), { recursive: true });
    // Only the offending self-file exists — no linked tickets at all.
    fs.writeFileSync(
      path.join(isoTasksDir, '_related', `${SELF_ID}.md`),
      VALID_BODY
    );
    const manifest = {
      self: { id: SELF_ID, title: 'Self ticket' },
      parent: null,
      siblings: [],
    };
    const errors = validateArtifacts(isoTasksDir, manifest, []);
    const offending = path.join(isoTasksDir, '_related', `${SELF_ID}.md`);
    assert.ok(
      errors.some((e) => e.includes(offending)),
      `expected error to flag ${offending} even with empty linkedIds, got: ${JSON.stringify(errors)}`
    );
    fs.rmSync(isoRoot, { recursive: true, force: true });
  });

  it('does NOT flag _related/<self>.md when the self file is absent (happy path stays green)', () => {
    const cleanRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inputs-validate-self-clean-'));
    const cleanTasksDir = path.join(cleanRoot, SELF_ID);
    fs.mkdirSync(path.join(cleanTasksDir, '_related'), { recursive: true });
    fs.writeFileSync(
      path.join(cleanTasksDir, '_related', `${LINKED_ID}.md`),
      VALID_BODY
    );
    const manifest = {
      self: { id: SELF_ID, title: 'Self ticket' },
      parent: null,
      siblings: [{ id: LINKED_ID, title: 'Linked sibling' }],
    };
    const errors = validateArtifacts(cleanTasksDir, manifest, [LINKED_ID]);
    assert.deepEqual(
      errors,
      [],
      `expected no errors on clean fixture, got: ${JSON.stringify(errors)}`
    );
    fs.rmSync(cleanRoot, { recursive: true, force: true });
  });
});
