/**
 * Integration tests for `validateIntraTicketScope` (Task 1 of GH-485).
 *
 * Scenarios covered (verbatim titles required by task-next.js RED gate):
 *   - validator rejects tasks.md where a file is in-scope for one task and
 *     out-of-scope for another
 *   - validator accepts tasks.md after intra-ticket conflict is removed
 *   - validator preserves cross-ticket sibling-owned out-of-scope semantics
 *   - glob in-scope entry conflicts with literal out-of-scope entry in a peer task
 *
 * Uses node:test + node:assert/strict (project convention — see
 * plugins/work/CLAUDE.md "Node built-in test runner").
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TASK_SCOPE_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'workflows',
  'lib',
  'task-scope'
);
const TASK_PARSER_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'workflows',
  'work',
  'lib',
  'task-parser'
);

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'intra-ticket-scope-conflict');

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'intra-ticket-scope-test-'));
}

function teardown() {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}

/**
 * Stage a fixture tasks.md in a temp dir and parse it through the real
 * task-parser so the test mirrors what tasks-gate.js sees at runtime.
 */
function parseFixture(fixtureFilename) {
  const src = fs.readFileSync(path.join(FIXTURE_DIR, fixtureFilename), 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'tasks.md'), src, 'utf8');
  const { parseTasks } = require(TASK_PARSER_PATH);
  return parseTasks(tmpDir);
}

describe('validateIntraTicketScope', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('validator rejects tasks.md where a file is in-scope for one task and out-of-scope for another', () => {
    const { validateIntraTicketScope } = require(TASK_SCOPE_PATH);
    assert.equal(
      typeof validateIntraTicketScope,
      'function',
      'validateIntraTicketScope must be exported from lib/task-scope.js'
    );

    const tasks = parseFixture('tasks.md');
    assert.ok(Array.isArray(tasks) && tasks.length === 4, 'fixture must parse to 4 tasks');

    const errors = validateIntraTicketScope(tasks);
    assert.ok(Array.isArray(errors), 'validator must return an array');
    assert.equal(
      errors.length,
      3,
      `invalid fixture must produce exactly 3 intra-ticket errors (one per offending out-of-scope listing); got ${errors.length}: ${JSON.stringify(errors, null, 2)}`
    );
    for (const err of errors) {
      assert.match(
        err,
        /components\/X\.tsx/,
        `every intra-ticket error must name the conflicting file; got: ${err}`
      );
      assert.match(
        err,
        /\bTask\s*3\b/i,
        `every intra-ticket error must reference Task 3 (the in-scope owner); got: ${err}`
      );
    }
    // Each of Tasks 1, 2, 4 should appear in at least one error message
    // (one error per out-of-scope listing).
    for (const offending of [1, 2, 4]) {
      const matched = errors.some((e) => new RegExp(`\\bTask\\s*${offending}\\b`, 'i').test(e));
      assert.ok(
        matched,
        `expected an intra-ticket error referencing Task ${offending}; got: ${JSON.stringify(errors)}`
      );
    }
  });

  it('validator accepts tasks.md after intra-ticket conflict is removed', () => {
    const { validateIntraTicketScope } = require(TASK_SCOPE_PATH);
    const tasks = parseFixture('tasks.fixed.md');
    assert.ok(
      Array.isArray(tasks) && tasks.length === 4,
      'corrected fixture must parse to 4 tasks'
    );

    const errors = validateIntraTicketScope(tasks);
    assert.deepEqual(
      errors,
      [],
      `corrected fixture must produce zero intra-ticket errors; got: ${JSON.stringify(errors, null, 2)}`
    );
  });

  it('validator preserves cross-ticket sibling-owned out-of-scope semantics', () => {
    const { validateIntraTicketScope } = require(TASK_SCOPE_PATH);
    // No peer task in this set owns `external/legacy/foo.tsx` — it's a
    // cross-ticket sibling-owned path (e.g. owned by a different ticket /
    // a long-merged module). The validator must NOT treat this as an
    // intra-ticket conflict.
    const tasks = [
      {
        num: 1,
        title: 'Add helper A',
        type: 'chore',
        filesInScope: ['lib/a.ts'],
        filesOutOfScope: ['external/legacy/foo.tsx'],
      },
      {
        num: 2,
        title: 'Add helper B',
        type: 'chore',
        filesInScope: ['lib/b.ts'],
        filesOutOfScope: ['external/legacy/foo.tsx'],
      },
    ];
    const errors = validateIntraTicketScope(tasks);
    assert.deepEqual(
      errors,
      [],
      `cross-ticket sibling-owned out-of-scope entries must NOT trigger intra-ticket errors; got: ${JSON.stringify(errors, null, 2)}`
    );
  });

  it('glob out-of-scope entry conflicts with literal in-scope entry in a peer task', () => {
    const { validateIntraTicketScope } = require(TASK_SCOPE_PATH);
    // Task A lists `app/api/routers/**` under out-of-scope; Task B owns the
    // literal `app/api/routers/users.ts` under in-scope. The out-of-scope
    // glob COVERS the literal — that is an intra-ticket conflict and the
    // validator must flag it (symmetric glob direction).
    const tasks = [
      {
        num: 1,
        title: 'Touch nothing in routers',
        type: 'chore',
        filesInScope: ['app/other.ts'],
        filesOutOfScope: ['app/api/routers/**'],
      },
      {
        num: 2,
        title: 'Own users router',
        type: 'wiring',
        filesInScope: ['app/api/routers/users.ts'],
        filesOutOfScope: [],
      },
    ];
    const errors = validateIntraTicketScope(tasks);
    assert.equal(
      errors.length,
      1,
      `glob-out-of-scope-vs-literal-in-scope conflict must produce exactly 1 error; got ${errors.length}: ${JSON.stringify(errors, null, 2)}`
    );
    const [err] = errors;
    assert.match(
      err,
      /app\/api\/routers\/\*\*/,
      `error must name the conflicting out-of-scope glob entry; got: ${err}`
    );
    assert.match(
      err,
      /\bTask\s*1\b/i,
      `error must name Task 1 (out-of-scope declarant); got: ${err}`
    );
    assert.match(
      err,
      /\bTask\s*2\b/i,
      `error must name Task 2 (in-scope literal owner); got: ${err}`
    );
  });

  it('glob in-scope entry conflicts with literal out-of-scope entry in a peer task', () => {
    const { validateIntraTicketScope } = require(TASK_SCOPE_PATH);
    // Task 1 owns `lib/foo/**`; Task 2 lists the literal `lib/foo/bar.ts`
    // under out-of-scope. The glob OWNS the literal — that is an
    // intra-ticket conflict and the validator must flag it.
    const tasks = [
      {
        num: 1,
        title: 'Own lib/foo',
        type: 'wiring',
        filesInScope: ['lib/foo/**'],
        filesOutOfScope: [],
      },
      {
        num: 2,
        title: 'Touch nothing in foo',
        type: 'chore',
        filesInScope: ['lib/other.ts'],
        filesOutOfScope: ['lib/foo/bar.ts'],
      },
    ];
    const errors = validateIntraTicketScope(tasks);
    assert.equal(
      errors.length,
      1,
      `glob-vs-literal conflict must produce exactly 1 error; got ${errors.length}: ${JSON.stringify(errors, null, 2)}`
    );
    const [err] = errors;
    assert.match(err, /lib\/foo\/bar\.ts/, `error must name the conflicting file; got: ${err}`);
    assert.match(err, /\bTask\s*1\b/i, `error must name Task 1 (owner via glob); got: ${err}`);
    assert.match(
      err,
      /\bTask\s*2\b/i,
      `error must name Task 2 (out-of-scope declarant); got: ${err}`
    );
  });
});
