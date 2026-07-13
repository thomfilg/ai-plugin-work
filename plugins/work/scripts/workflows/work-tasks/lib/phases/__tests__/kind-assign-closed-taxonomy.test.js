/**
 * kind_assign phase — closed Type taxonomy (GH-498 / #489 / #606 class).
 *
 * kind_assign used to validate `### Type` against the legacy domain kinds
 * (frontend/backend/wiring/e2e/devops/fullstack) while the planner docs and
 * the implement gate (`gateContractFor`) use the closed gate-contract enum
 * from skills/split-in-tasks/lib/task-types.js. The mismatch either failed
 * correctly-authored tasks.md at the tasks phase or let legacy kinds through
 * to wedge at implement under the strictest fail-closed contract.
 *
 * Run: node --test scripts/workflows/work-tasks/lib/phases/__tests__/kind-assign-closed-taxonomy.test.js
 */

'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const kindAssign = require('../kind_assign');
const { TASK_TYPES } = require('../../../../../../skills/split-in-tasks/lib/task-types');

function makeTasksDir(tasksMd) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kind-assign-test-'));
  fs.writeFileSync(path.join(dir, 'tasks.md'), tasksMd);
  return dir;
}

function taskBlock(num, type, scopeEntries) {
  return [
    `## Task ${num} — fixture task ${num}`,
    '',
    '### Type',
    type,
    '',
    '### Files in scope',
    ...scopeEntries.map((e) => `- \`${e}\``),
    '',
  ].join('\n');
}

describe('kind_assign — closed Type taxonomy', () => {
  const dirs = [];
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  function validate(tasksMd) {
    const dir = makeTasksDir(tasksMd);
    dirs.push(dir);
    return kindAssign.validateArtifacts(dir);
  }

  it('VALID_KINDS mirrors the canonical task-types enum', () => {
    assert.deepEqual([...kindAssign.VALID_KINDS].sort(), [...TASK_TYPES].sort());
  });

  it('accepts a well-formed tdd-code task (test + source in scope)', () => {
    const errors = validate(taskBlock(1, 'tdd-code', ['src/a.js', 'src/__tests__/a.test.js']));
    assert.deepEqual(errors, []);
  });

  it('accepts a docs task with .md-only scope', () => {
    const errors = validate(taskBlock(1, 'docs', ['README.md', 'docs/guide.md']));
    assert.deepEqual(errors, []);
  });

  it('accepts a tests-only task with test-only scope', () => {
    const errors = validate(taskBlock(1, 'tests-only', ['src/__tests__/a.test.js']));
    assert.deepEqual(errors, []);
  });

  it('accepts checkpoint / mechanical-refactor / file-move without scope constraints', () => {
    for (const type of ['checkpoint', 'mechanical-refactor', 'file-move']) {
      const errors = validate(taskBlock(1, type, ['src/anything.js']));
      assert.deepEqual(errors, [], `Type "${type}" should pass; got: ${errors.join(' | ')}`);
    }
  });

  it('rejects legacy domain kinds with a migration hint', () => {
    for (const [legacy, hintRe] of [
      ['backend', /tdd-code/],
      ['frontend', /tdd-code/],
      ['devops', /`ci` \(CI configs\)/],
      ['wiring', /mechanical-refactor/],
      ['e2e', /tests-only/],
      ['fullstack', /tdd-code/],
    ]) {
      const errors = validate(taskBlock(1, legacy, ['src/a.js']));
      assert.equal(errors.length, 1, `legacy "${legacy}" should produce exactly one error`);
      assert.match(errors[0], /must be one of: tdd-code/);
      assert.match(errors[0], hintRe);
    }
  });

  it('rejects a freeform Type without a legacy hint', () => {
    const errors = validate(taskBlock(1, 'feature', ['src/a.js']));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /"feature"/);
    assert.doesNotMatch(errors[0], /Legacy kind/);
  });

  it('rejects a docs task whose scope includes a non-.md file', () => {
    const errors = validate(taskBlock(1, 'docs', ['README.md', 'src/a.js']));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /outside the docs allowlist/);
    assert.match(errors[0], /`src\/a\.js`/);
  });

  it('rejects a tdd-code task with no test-authorship surface (#491/#489 class)', () => {
    const errors = validate(taskBlock(1, 'tdd-code', ['src/a.js']));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /RED gate is unsatisfiable/);
  });

  it('rejects a tdd-code task with tests but no source entry', () => {
    const errors = validate(taskBlock(1, 'tdd-code', ['src/__tests__/a.test.js']));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /non-test source entry/);
  });

  it('accepts a tdd-code task whose test surface is a glob', () => {
    const errors = validate(taskBlock(1, 'tdd-code', ['src/a.js', 'src/**/*.test.js']));
    assert.deepEqual(errors, []);
  });

  it('rejects a tests-only task whose scope includes a source file', () => {
    const errors = validate(taskBlock(1, 'tests-only', ['src/__tests__/a.test.js', 'src/a.js']));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /outside the tests-only allowlist/);
  });

  it('rejects a ci task whose scope leaves the CI allowlist', () => {
    const errors = validate(taskBlock(1, 'ci', ['Jenkinsfile', 'src/a.js']));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /outside the ci allowlist/);
  });

  it('aggregates errors across multiple tasks', () => {
    const md = [
      taskBlock(1, 'devops', ['scripts/deploy.yml']),
      taskBlock(2, 'docs', ['README.md', 'src/a.js']),
    ].join('\n');
    const errors = validate(md);
    assert.equal(errors.length, 2);
    assert.match(errors[0], /Task 1/);
    assert.match(errors[1], /Task 2/);
  });

  it('instructions mention the closed enum, not the legacy kinds', () => {
    const text = kindAssign.instructions({ ticket: 'GH-1' });
    assert.match(text, /tdd-code/);
    assert.doesNotMatch(text, /\bfullstack\b/);
  });
});
