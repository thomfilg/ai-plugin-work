'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseFeatureFile,
  parseTaskScenarios,
  validateConsistency,
  collectTaskTestPaths,
  findMissingTestFiles,
} = require('../gherkin-task-refs.js');

const FEATURE = `Feature: External assets

  @integration
  @task:1
  @test:components/foo/foo.integration.test.tsx
  Scenario: foo bars the baz
    Given x
    When y
    Then z

  @e2e
  @task:1
  @test:tests/e2e/foo.spec.ts
  @test:components/foo/foo.e2e.test.tsx
  Scenario: foo handles empty input
    Given a
    When b
    Then c

  @integration
  @task:2
  @test:components/bar/bar.test.tsx
  Scenario: bar does the thing
    Given p
    When q
    Then r
`;

const TASKS_MD = `# tasks

## Task 1 — Foo
### Type
frontend

### Scenarios
- foo bars the baz
- foo handles empty input

## Task 2 — Bar
### Type
backend

### Scenarios
- bar does the thing
`;

describe('parseFeatureFile', () => {
  it('extracts @task and @test tags per scenario', () => {
    const { scenarios, errors } = parseFeatureFile(FEATURE);
    assert.equal(errors.length, 0, `unexpected errors: ${errors.join('; ')}`);
    assert.equal(scenarios.length, 3);
    assert.equal(scenarios[0].name, 'foo bars the baz');
    assert.equal(scenarios[0].taskNum, 1);
    assert.deepEqual(scenarios[0].testPaths, ['components/foo/foo.integration.test.tsx']);
    assert.equal(scenarios[1].name, 'foo handles empty input');
    assert.equal(scenarios[1].taskNum, 1);
    assert.deepEqual(scenarios[1].testPaths, [
      'tests/e2e/foo.spec.ts',
      'components/foo/foo.e2e.test.tsx',
    ]);
    assert.equal(scenarios[2].taskNum, 2);
  });

  it('flags scenarios with no @task tag', () => {
    const broken = `Feature: x
  @e2e
  @test:foo.test.ts
  Scenario: unrooted
    Given x
    Then y
`;
    const { scenarios, errors } = parseFeatureFile(broken);
    assert.equal(scenarios[0].taskNum, null);
    // parseFeatureFile collects errors only for multi-task-tag scenarios;
    // missing-task is surfaced by validateConsistency.
    assert.equal(errors.length, 0);
  });

  it('extracts tags from Scenario Outline entries (parity with task-next.js)', () => {
    const withOutline = `Feature: x
  @integration
  @task:1
  @test:components/foo/foo.test.tsx
  Scenario Outline: foo handles <input>
    Given <input>
    When processed
    Then <output>

    Examples:
      | input | output |
      | a     | A      |
`;
    const { scenarios, errors } = parseFeatureFile(withOutline);
    assert.equal(errors.length, 0, `unexpected errors: ${errors.join('; ')}`);
    assert.equal(scenarios.length, 1);
    assert.equal(scenarios[0].name, 'foo handles <input>');
    assert.equal(scenarios[0].taskNum, 1);
    assert.deepEqual(scenarios[0].testPaths, ['components/foo/foo.test.tsx']);
  });

  it('flags scenarios with multiple @task tags', () => {
    const broken = `Feature: x
  @task:1
  @task:2
  @test:foo.test.ts
  Scenario: ambiguous
    Given x
    Then y
`;
    const { errors } = parseFeatureFile(broken);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /multiple @task: tags/);
  });
});

describe('parseTaskScenarios', () => {
  it('returns a map of taskNum → scenario names', () => {
    const map = parseTaskScenarios(TASKS_MD);
    assert.equal(map.size, 2);
    assert.ok(map.get(1).has('foo bars the baz'));
    assert.ok(map.get(1).has('foo handles empty input'));
    assert.ok(map.get(2).has('bar does the thing'));
  });

  it('omits tasks with no ### Scenarios section', () => {
    const text = `## Task 1
### Type
frontend
`;
    const map = parseTaskScenarios(text);
    assert.equal(map.size, 0);
  });

  it('strips trailing punctuation and ignores commented bullets', () => {
    const text = `## Task 1
### Scenarios
- scenario one.
- scenario two:
<!-- ignored -->
* scenario three
`;
    const map = parseTaskScenarios(text);
    const names = map.get(1);
    assert.ok(names.has('scenario one'));
    assert.ok(names.has('scenario two'));
    assert.ok(names.has('scenario three'));
    assert.equal(names.size, 3);
  });
});

describe('validateConsistency', () => {
  it('passes when every scenario is referenced and tagged', () => {
    const res = validateConsistency({
      gherkinText: FEATURE,
      tasksMdText: TASKS_MD,
      knownTaskNums: new Set([1, 2]),
    });
    assert.equal(res.valid, true, `errors: ${res.errors.join('; ')}`);
  });

  it('fails when a scenario lacks @task', () => {
    const broken = FEATURE.replace('  @task:2\n', '');
    const res = validateConsistency({
      gherkinText: broken,
      tasksMdText: TASKS_MD,
      knownTaskNums: new Set([1, 2]),
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => /missing an @task:N tag/.test(e)));
  });

  it('fails when a scenario lacks @test', () => {
    const broken = FEATURE.replace('  @test:components/bar/bar.test.tsx\n', '');
    const res = validateConsistency({
      gherkinText: broken,
      tasksMdText: TASKS_MD,
      knownTaskNums: new Set([1, 2]),
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => /missing an @test:<path> tag/.test(e)));
  });

  it('fails when tasks.md lists a scenario not present in gherkin', () => {
    const extra = TASKS_MD.replace(
      '- bar does the thing\n',
      '- bar does the thing\n- never authored\n'
    );
    const res = validateConsistency({
      gherkinText: FEATURE,
      tasksMdText: extra,
      knownTaskNums: new Set([1, 2]),
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => /never authored/.test(e) && /not present in gherkin/.test(e)));
  });

  it('fails when gherkin scenario is not listed under its task in tasks.md', () => {
    const trimmedTasks = TASKS_MD.replace('- foo bars the baz\n', '');
    const res = validateConsistency({
      gherkinText: FEATURE,
      tasksMdText: trimmedTasks,
      knownTaskNums: new Set([1, 2]),
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => /not listed under `### Scenarios` in Task 1/.test(e)));
  });

  it('fails when @task points at a task that does not exist', () => {
    const res = validateConsistency({
      gherkinText: FEATURE,
      tasksMdText: TASKS_MD,
      knownTaskNums: new Set([1]), // task 2 removed
    });
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => /tasks.md has no Task 2/.test(e)));
  });
});

describe('collectTaskTestPaths', () => {
  it('returns sorted unique test paths for a task', () => {
    const paths = collectTaskTestPaths({ gherkinText: FEATURE }, 1);
    assert.deepEqual(paths, [
      'components/foo/foo.e2e.test.tsx',
      'components/foo/foo.integration.test.tsx',
      'tests/e2e/foo.spec.ts',
    ]);
  });

  it('returns [] for a task with no scenarios', () => {
    const paths = collectTaskTestPaths({ gherkinText: FEATURE }, 99);
    assert.deepEqual(paths, []);
  });
});

describe('findMissingTestFiles', () => {
  it('flags only the paths missing from disk', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gherkin-refs-'));
    try {
      const present = 'components/foo/foo.integration.test.tsx';
      const presentAbs = path.join(tmp, present);
      fs.mkdirSync(path.dirname(presentAbs), { recursive: true });
      fs.writeFileSync(presentAbs, '// stub');
      const { missing, all } = findMissingTestFiles({ gherkinText: FEATURE, worktreeDir: tmp }, 1);
      assert.equal(all.length, 3);
      assert.deepEqual(missing, ['components/foo/foo.e2e.test.tsx', 'tests/e2e/foo.spec.ts']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
