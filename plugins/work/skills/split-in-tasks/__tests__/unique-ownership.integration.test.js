/**
 * Integration tests for `validateUniqueOwnership` (Task 1 of GH-516).
 *
 * Scenarios covered (verbatim titles required by task-next.js RED gate):
 *   - validator rejects two peer tasks listing the same literal path under Files in scope
 *   - validator rejects a glob in Task A overlapping with a literal in peer Task B
 *   - validator rejects reverse glob-vs-literal overlap symmetrically
 *   - validator accepts disjoint scope sets without false positives
 *   - validator preserves existing intra-ticket-scope semantics
 *   - error message format includes the documented pointer
 *
 * Uses node:test + node:assert/strict (project convention).
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

const FIXTURE_DIR = path.resolve(__dirname, 'fixtures', 'unique-ownership-conflict');

let tmpDir;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unique-ownership-test-'));
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

describe('validateUniqueOwnership', () => {
  beforeEach(() => setup());
  afterEach(() => teardown());

  it('validator rejects two peer tasks listing the same literal path under Files in scope', () => {
    const { validateUniqueOwnership } = require(TASK_SCOPE_PATH);
    assert.equal(
      typeof validateUniqueOwnership,
      'function',
      'validateUniqueOwnership must be exported from lib/task-scope.js'
    );

    const tasks = parseFixture('literal-vs-literal.tasks.md');
    assert.ok(Array.isArray(tasks) && tasks.length === 2, 'fixture must parse to 2 tasks');

    const errors = validateUniqueOwnership(tasks);
    assert.ok(Array.isArray(errors), 'validator must return an array');
    assert.ok(
      errors.length >= 1,
      `literal-vs-literal fixture must produce ≥1 error; got ${errors.length}`
    );
    const matched = errors.some(
      (e) =>
        /lib\/a\.ts/.test(e) && /\bTask\s*1\b/i.test(e) && /\bTask\s*2\b/i.test(e)
    );
    assert.ok(
      matched,
      `expected an error naming lib/a.ts and both Task 1 and Task 2; got: ${JSON.stringify(errors)}`
    );
  });

  it('validator rejects a glob in Task A overlapping with a literal in peer Task B', () => {
    const { validateUniqueOwnership } = require(TASK_SCOPE_PATH);
    const tasks = parseFixture('glob-vs-literal.tasks.md');
    assert.ok(Array.isArray(tasks) && tasks.length === 2, 'fixture must parse to 2 tasks');

    const errors = validateUniqueOwnership(tasks);
    assert.ok(
      errors.length >= 1,
      `glob-vs-literal fixture must produce ≥1 error; got ${errors.length}`
    );
    const matched = errors.some(
      (e) =>
        /lib\/foo\/bar\.ts/.test(e) &&
        /\bTask\s*1\b/i.test(e) &&
        /\bTask\s*2\b/i.test(e)
    );
    assert.ok(
      matched,
      `expected an error naming the literal hit by the glob and both tasks; got: ${JSON.stringify(errors)}`
    );
  });

  it('validator rejects reverse glob-vs-literal overlap symmetrically', () => {
    const { validateUniqueOwnership } = require(TASK_SCOPE_PATH);
    const tasks = parseFixture('reverse-glob-vs-literal.tasks.md');
    assert.ok(Array.isArray(tasks) && tasks.length === 2, 'fixture must parse to 2 tasks');

    const errors = validateUniqueOwnership(tasks);
    assert.ok(
      errors.length >= 1,
      `reverse-glob-vs-literal fixture must produce ≥1 error; got ${errors.length}`
    );
    const matched = errors.some(
      (e) =>
        /app\/api\/routers\/users\.ts/.test(e) &&
        /\bTask\s*1\b/i.test(e) &&
        /\bTask\s*2\b/i.test(e)
    );
    assert.ok(
      matched,
      `expected an error naming app/api/routers/users.ts and both tasks; got: ${JSON.stringify(errors)}`
    );
  });

  it('validator accepts disjoint scope sets without false positives', () => {
    const { validateUniqueOwnership } = require(TASK_SCOPE_PATH);
    const tasks = parseFixture('negative-non-overlap.tasks.md');
    assert.ok(Array.isArray(tasks) && tasks.length === 3, 'fixture must parse to 3 tasks');

    const errors = validateUniqueOwnership(tasks);
    assert.deepEqual(
      errors,
      [],
      `disjoint fixture must produce zero unique-ownership errors; got: ${JSON.stringify(errors, null, 2)}`
    );
  });

  it('validator preserves existing intra-ticket-scope semantics', () => {
    const { validateAll } = require(TASK_SCOPE_PATH);
    // Mix both classes of conflict in a single tasks set:
    //   - Tasks 1 & 2 both own `lib/a.ts` (unique-ownership conflict)
    //   - Task 3 owns `components/X.tsx` in-scope; Task 1 lists it out-of-scope
    //     (intra-ticket conflict)
    const tasks = [
      {
        num: 1,
        title: 'Add helper A',
        type: 'chore',
        filesInScope: ['lib/a.ts'],
        filesOutOfScope: ['components/X.tsx'],
      },
      {
        num: 2,
        title: 'Edit helper A again',
        type: 'chore',
        filesInScope: ['lib/a.ts'],
        filesOutOfScope: [],
      },
      {
        num: 3,
        title: 'Wire X',
        type: 'wiring',
        filesInScope: ['components/X.tsx'],
        filesOutOfScope: [],
      },
    ];

    const { errors } = validateAll(tasks);
    assert.ok(Array.isArray(errors), 'validateAll must return errors array');
    const hasUniqueOwnership = errors.some(
      (e) => /lib\/a\.ts/.test(e) && /Unique-ownership/i.test(e)
    );
    const hasIntraTicket = errors.some(
      (e) => /components\/X\.tsx/.test(e) && /intra-ticket exclusion rule/i.test(e)
    );
    assert.ok(
      hasUniqueOwnership,
      `validateAll must surface unique-ownership errors; got: ${JSON.stringify(errors, null, 2)}`
    );
    assert.ok(
      hasIntraTicket,
      `validateAll must still surface intra-ticket-scope errors; got: ${JSON.stringify(errors, null, 2)}`
    );
  });

  it('error message format includes the documented pointer', () => {
    const { validateUniqueOwnership } = require(TASK_SCOPE_PATH);
    const tasks = [
      {
        num: 1,
        title: 'Own a',
        type: 'chore',
        filesInScope: ['lib/a.ts'],
        filesOutOfScope: [],
      },
      {
        num: 2,
        title: 'Also own a',
        type: 'chore',
        filesInScope: ['lib/a.ts'],
        filesOutOfScope: [],
      },
    ];
    const errors = validateUniqueOwnership(tasks);
    assert.ok(errors.length >= 1, `expected ≥1 error; got ${errors.length}`);
    const [err] = errors;
    assert.match(err, /\bTask\s*1\b/i, `error must reference Task 1; got: ${err}`);
    assert.match(err, /\bTask\s*2\b/i, `error must reference Task 2; got: ${err}`);
    assert.match(err, /`lib\/a\.ts`/, `error must render the path in backticks; got: ${err}`);
    assert.match(err, /Files in scope/, `error must mention Files in scope; got: ${err}`);
    assert.match(
      err,
      /skills\/split-in-tasks\/docs\/scope-sections\.md/,
      `error must point to scope-sections.md; got: ${err}`
    );
    assert.match(
      err,
      /Unique-ownership/,
      `error must reference the Unique-ownership rule; got: ${err}`
    );
  });
});
