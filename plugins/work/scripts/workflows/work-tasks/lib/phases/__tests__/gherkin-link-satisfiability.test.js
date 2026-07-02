/**
 * gherkin_link — @task:N scenario satisfiability (#489 / #491 class).
 *
 * A task that owns @task:N-tagged scenarios but whose `### Files in scope`
 * cannot match any test file is unimplementable at RED: the implement gate
 * requires each tagged scenario to appear in a test file under the task's
 * scope, while protect-task-scope blocks creating test files outside it.
 *
 * Run: node --test scripts/workflows/work-tasks/lib/phases/__tests__/gherkin-link-satisfiability.test.js
 */

'use strict';

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const gherkinLink = require('../gherkin_link');

const dirs = [];
function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gherkin-link-test-'));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
  return dir;
}

function taskBlock(num, type, scopeEntries, opts = {}) {
  const lines = [
    `## Task ${num} — fixture task ${num}`,
    '',
    '### Type',
    type,
    '',
    '### Acceptance Criteria',
    `- covers scenario for task ${num}`,
    '',
    '### Files in scope',
    ...scopeEntries.map((e) => `- \`${e}\``),
    '',
  ];
  if (opts.scenarios) {
    lines.push('### Scenarios', ...opts.scenarios.map((s) => `- ${s}`), '');
  }
  return lines.join('\n');
}

// A scenario block that satisfies the canonical gherkin-task-refs validator:
// steps present, @test tag present. The satisfiability check under test here
// is orthogonal (scope shape), so keep the rest canonical-valid.
function scenario(taskNum, title) {
  return [
    `@task:${taskNum} @test:src/__tests__/fixture.test.js`,
    `Scenario: ${title}`,
    '  Given a fixture',
    '  When it runs',
    '  Then it passes',
  ];
}

function feature(...scenarioLines) {
  return ['Feature: fixture', '', ...scenarioLines, ''].join('\n');
}

describe('gherkin_link — @task:N satisfiability', () => {
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('countTaggedScenarios maps task numbers to scenario counts', () => {
    const counts = gherkinLink.countTaggedScenarios(
      feature(
        '@task:1 @integration',
        'Scenario: first thing covers scenario for task 1',
        '',
        '@task:1',
        'Scenario: second thing covers scenario for task 1',
        '',
        '@task:3',
        'Scenario Outline: third covers scenario for task 3'
      )
    );
    assert.equal(counts.get(1), 2);
    assert.equal(counts.get(3), 1);
    assert.equal(counts.has(2), false);
  });

  it('blocks a docs-only task that owns a @task:N scenario (#489 shape)', () => {
    const dir = makeDir({
      'gherkin.feature': feature('@task:1', 'Scenario: covers scenario for task 1'),
      'tasks.md': taskBlock(1, 'docs', ['SKILL.md']),
    });
    const errors = gherkinLink.validateArtifacts(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Task 1 owns 1 @task:1-tagged scenario/);
    assert.match(errors[0], /RED gate would be unsatisfiable/);
  });

  it('blocks a source-literal-only scope with tagged scenarios (#491 shape)', () => {
    const dir = makeDir({
      'gherkin.feature': feature('@task:2', 'Scenario: covers scenario for task 2'),
      'tasks.md': [
        taskBlock(1, 'docs', ['README.md']),
        taskBlock(2, 'tdd-code', ['src/parser.js']),
      ].join('\n'),
    });
    const errors = gherkinLink.validateArtifacts(dir);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Task 2/);
  });

  it('passes when the tagged task has a test-file literal in scope', () => {
    const dir = makeDir({
      'gherkin.feature': feature(...scenario(1, 'covers scenario for task 1')),
      'tasks.md': taskBlock(1, 'tdd-code', ['src/parser.js', 'src/__tests__/parser.test.js'], {
        scenarios: ['covers scenario for task 1'],
      }),
    });
    assert.deepEqual(gherkinLink.validateArtifacts(dir), []);
  });

  it('passes when the tagged task scope has a wide glob that admits tests', () => {
    const dir = makeDir({
      'gherkin.feature': feature(...scenario(1, 'covers scenario for task 1')),
      'tasks.md': taskBlock(1, 'tdd-code', ['src/**'], {
        scenarios: ['covers scenario for task 1'],
      }),
    });
    assert.deepEqual(gherkinLink.validateArtifacts(dir), []);
  });

  it('passes when a directory-prefix literal is in scope (fail-open)', () => {
    const dir = makeDir({
      'gherkin.feature': feature(...scenario(1, 'covers scenario for task 1')),
      'tasks.md': taskBlock(1, 'tdd-code', ['src/utils'], {
        scenarios: ['covers scenario for task 1'],
      }),
    });
    assert.deepEqual(gherkinLink.validateArtifacts(dir), []);
  });

  it('ignores tasks with no tagged scenarios (satisfiability pass is silent)', () => {
    const dir = makeDir({
      'gherkin.feature': feature(
        '@integration @test:src/__tests__/fixture.test.js',
        'Scenario: covers scenario for task 1',
        '  Given a fixture',
        '  When it runs',
        '  Then it passes'
      ),
      'tasks.md': taskBlock(1, 'docs', ['README.md']),
    });
    const errors = gherkinLink.validateArtifacts(dir);
    assert.ok(
      !errors.some((e) => /unsatisfiable/.test(e)),
      `no satisfiability error expected; got: ${errors.join(' | ')}`
    );
  });

  it('still auto-passes when gherkin.feature is absent', () => {
    const dir = makeDir({ 'tasks.md': taskBlock(1, 'docs', ['README.md']) });
    assert.deepEqual(gherkinLink.validateArtifacts(dir), []);
  });
});
