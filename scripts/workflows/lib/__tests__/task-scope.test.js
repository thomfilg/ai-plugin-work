/**
 * Tests for lib/task-scope.js (Gate C validators).
 *
 * Run: node --test scripts/workflows/lib/__tests__/task-scope.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ts = require('../task-scope');

describe('validateTask', () => {
  it('passes when both sections are populated', () => {
    const errors = ts.validateTask({
      num: 1,
      filesInScope: ['lib/x.ts'],
      filesOutOfScope: ['lib/y.ts'],
    });
    assert.deepEqual(errors, []);
  });

  it('passes with empty filesOutOfScope (no siblings)', () => {
    const errors = ts.validateTask({
      num: 1,
      filesInScope: ['lib/x.ts'],
      filesOutOfScope: [],
    });
    assert.deepEqual(errors, []);
  });

  it('fails when both filesInScope and suggestedScope are missing', () => {
    const errors = ts.validateTask({ num: 2, filesOutOfScope: [] });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Task 2/);
    assert.match(errors[0], /Files in scope/);
  });

  it('fails when both filesInScope and suggestedScope are empty', () => {
    const errors = ts.validateTask({
      num: 3,
      filesInScope: [],
      suggestedScope: '',
      filesOutOfScope: [],
    });
    assert.equal(errors.length, 1);
  });

  it('accepts legacy suggestedScope as fallback when filesInScope is missing', () => {
    const errors = ts.validateTask({
      num: 5,
      filesInScope: [],
      suggestedScope: '- lib/x.ts',
      filesOutOfScope: [],
    });
    assert.deepEqual(errors, []);
  });

  it('fails when filesOutOfScope is non-array (malformed)', () => {
    const errors = ts.validateTask({ num: 4, filesInScope: ['x.ts'], filesOutOfScope: 'oops' });
    assert.match(errors.join('|'), /out of scope/);
  });

  it('tolerates missing filesOutOfScope (legacy task)', () => {
    const errors = ts.validateTask({ num: 6, filesInScope: ['x.ts'] });
    assert.deepEqual(errors, []);
  });

  it('handles non-object input gracefully', () => {
    assert.deepEqual(ts.validateTask(null), ['task must be an object']);
    assert.deepEqual(ts.validateTask(undefined), ['task must be an object']);
  });
});

describe('validateAll', () => {
  it('returns valid:true when all tasks pass', () => {
    const result = ts.validateAll([
      { num: 1, filesInScope: ['a.ts'], filesOutOfScope: [] },
      { num: 2, filesInScope: ['b.ts'], filesOutOfScope: ['c.ts'] },
    ]);
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it('aggregates errors across all tasks', () => {
    const result = ts.validateAll([
      { num: 1, filesInScope: [], filesOutOfScope: [] },
      { num: 2, filesOutOfScope: 'bad' },
    ]);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 2);
    assert.match(result.errors.join('|'), /Task 1/);
    assert.match(result.errors.join('|'), /Task 2/);
  });

  it('fails on empty or non-array input', () => {
    assert.equal(ts.validateAll([]).valid, false);
    assert.equal(ts.validateAll(null).valid, false);
    assert.equal(ts.validateAll(undefined).valid, false);
  });
});

describe('unionFilesInScope', () => {
  it('returns deduped union across tasks', () => {
    const out = ts.unionFilesInScope([
      { num: 1, filesInScope: ['a.ts', 'b.ts'] },
      { num: 2, filesInScope: ['b.ts', 'c.ts'] },
    ]);
    assert.deepEqual(out.sort(), ['a.ts', 'b.ts', 'c.ts']);
  });

  it('tolerates missing filesInScope', () => {
    const out = ts.unionFilesInScope([{ num: 1 }, { num: 2, filesInScope: ['x.ts'] }]);
    assert.deepEqual(out, ['x.ts']);
  });

  it('returns [] for non-array', () => {
    assert.deepEqual(ts.unionFilesInScope(null), []);
  });
});

describe('validateTaskTestScope (regression: ECHO-4637-class deadlock)', () => {
  it('passes when CHANGED_FILES is a strict subset of Files in scope', () => {
    const task = {
      num: 2,
      filesInScope: [
        'lib/external-assets/update-tags.ts',
        'lib/external-assets/__tests__/update-tags.test.ts',
      ],
      testCommand:
        'CHANGED_FILES="lib/external-assets/__tests__/update-tags.test.ts" eval "$TEST_UNIT_COMMAND"',
    };
    assert.deepEqual(ts.validateTaskTestScope(task), []);
  });

  it('blocks when CHANGED_FILES references a sibling-owned integration test', () => {
    // The exact ECHO-4637 shape: Task 2 ships only the helper but its test
    // command runs through tRPC integration tests, traversing code owned by
    // Task 4 (schema narrowing).
    const task = {
      num: 2,
      filesInScope: ['lib/external-assets/update-tags.ts'],
      testCommand:
        'CHANGED_FILES="lib/external-assets/update-tags.ts ' +
        'app/api/trpc/routers/__tests__/external-assets-tags.integration.test.ts ' +
        'lib/validation/__tests__/external-asset-update-tags.test.ts" ' +
        'eval "$TEST_INTEGRATION_COMMAND"',
    };
    const errors = ts.validateTaskTestScope(task);
    assert.ok(errors.length >= 1, `expected at least one error, got ${errors.length}`);
    const deadlock = errors.find((e) => /deadlock/i.test(e));
    assert.ok(deadlock, 'expected a deadlock error');
    assert.match(deadlock, /Task 2/);
    assert.match(deadlock, /external-assets-tags\.integration\.test\.ts/);
    assert.match(deadlock, /lib\/validation\/__tests__\/external-asset-update-tags\.test\.ts/);
  });

  it('honours glob patterns in Files in scope', () => {
    const task = {
      num: 1,
      filesInScope: ['lib/foo/**', 'tests/foo/**'],
      testCommand: 'CHANGED_FILES="lib/foo/bar.ts tests/foo/bar.test.ts" eval "$TEST_UNIT_COMMAND"',
    };
    assert.deepEqual(ts.validateTaskTestScope(task), []);
  });

  it('skips check when testCommand is absent (legacy tasks)', () => {
    const task = { num: 3, filesInScope: ['lib/foo.ts'], testCommand: null };
    assert.deepEqual(ts.validateTaskTestScope(task), []);
  });

  it('skips check when Test Command does not use the canonical CHANGED_FILES envelope', () => {
    const task = {
      num: 4,
      filesInScope: ['lib/foo.ts'],
      testCommand: 'pnpm test lib/other/something.test.ts',
    };
    assert.deepEqual(ts.validateTaskTestScope(task), []);
  });

  it('validateAll surfaces test-scope errors alongside scope-envelope errors', () => {
    const tasks = [
      {
        num: 1,
        filesInScope: ['lib/foo.ts'],
        testCommand: 'CHANGED_FILES="lib/bar.ts" eval "$TEST_UNIT_COMMAND"',
      },
    ];
    const r = ts.validateAll(tasks);
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /references files not in its/.test(e)));
  });
});

describe('extractChangedFilesFromTestCommand', () => {
  const cases = [
    ['CHANGED_FILES="a.ts b.ts" eval "$X"', ['a.ts', 'b.ts']],
    [`CHANGED_FILES='a.ts b.ts' eval "$X"`, ['a.ts', 'b.ts']],
    ['CHANGED_FILES="a.ts" eval "$X" && CHANGED_FILES="b.ts" eval "$Y"', ['a.ts']],
    ['pnpm test foo.ts', []],
    [null, []],
    ['', []],
  ];
  for (const [input, expected] of cases) {
    it(`parses: ${JSON.stringify(input)}`, () => {
      assert.deepEqual(ts.extractChangedFilesFromTestCommand(input), expected);
    });
  }
});

describe('test-file naming convention (integration / e2e)', () => {
  describe('isIntegrationTestPath', () => {
    const cases = [
      ['lib/foo/__tests__/bar.integration.test.ts', true],
      ['lib/foo/bar.integration.spec.tsx', true],
      ['tests/integration/handler.test.ts', true],
      ['app/integration/foo.spec.js', true],
      ['lib/foo/bar.test.ts', false], // plain unit
      ['lib/foo/bar.spec.ts', false], // plain unit
      ['tests/e2e/bar.test.ts', false], // e2e, not integration
      ['lib/foo/bar.integration.ts', false], // not a test file
      ['lib/integrationhelpers/foo.test.ts', false], // word boundary
    ];
    for (const [p, expected] of cases) {
      it(`${JSON.stringify(p)} → ${expected}`, () => {
        assert.equal(ts.isIntegrationTestPath(p), expected);
      });
    }
  });

  describe('isE2eTestPath', () => {
    const cases = [
      ['tests/e2e/specs/login.e2e.spec.ts', true],
      ['app/e2e/foo.spec.ts', true],
      ['lib/foo/bar.e2e.test.ts', true],
      ['lib/foo/bar.test.ts', false],
      ['lib/foo/bar.integration.test.ts', false],
      ['lib/e2ehelper/foo.test.ts', false], // word boundary
    ];
    for (const [p, expected] of cases) {
      it(`${JSON.stringify(p)} → ${expected}`, () => {
        assert.equal(ts.isE2eTestPath(p), expected);
      });
    }
  });

  describe('validateTaskTestScope: runner-vs-naming consistency', () => {
    it('blocks $TEST_INTEGRATION_COMMAND with a non-integration test file', () => {
      const task = {
        num: 1,
        filesInScope: ['lib/foo/**', 'tests/**'],
        testCommand:
          'CHANGED_FILES="lib/foo/bar.ts tests/foo/bar.test.ts" eval "$TEST_INTEGRATION_COMMAND"',
      };
      const errors = ts.validateTaskTestScope(task);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /not named as integration tests/i);
      assert.match(errors[0], /bar\.test\.ts/);
    });

    it('blocks $TEST_E2E_COMMAND with a non-e2e test file', () => {
      const task = {
        num: 2,
        filesInScope: ['tests/**'],
        testCommand: 'CHANGED_FILES="tests/foo.test.ts" eval "$TEST_E2E_COMMAND"',
      };
      const errors = ts.validateTaskTestScope(task);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /not named as e2e tests/i);
    });

    it('blocks $TEST_UNIT_COMMAND when test file IS an integration test', () => {
      const task = {
        num: 3,
        filesInScope: ['lib/foo/**'],
        testCommand:
          'CHANGED_FILES="lib/foo/__tests__/bar.integration.test.ts" eval "$TEST_UNIT_COMMAND"',
      };
      const errors = ts.validateTaskTestScope(task);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /integration- or e2e-named/);
    });

    it('blocks $TEST_UNIT_COMMAND when test file IS an e2e test', () => {
      const task = {
        num: 4,
        filesInScope: ['tests/**'],
        testCommand: 'CHANGED_FILES="tests/e2e/foo.spec.ts" eval "$TEST_UNIT_COMMAND"',
      };
      const errors = ts.validateTaskTestScope(task);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /integration- or e2e-named/);
    });

    it('passes correctly named integration test with the integration runner', () => {
      const task = {
        num: 5,
        filesInScope: ['lib/foo/**'],
        testCommand:
          'CHANGED_FILES="lib/foo/bar.integration.test.ts" eval "$TEST_INTEGRATION_COMMAND"',
      };
      assert.deepEqual(ts.validateTaskTestScope(task), []);
    });

    it('passes correctly named e2e test with the e2e runner', () => {
      const task = {
        num: 6,
        filesInScope: ['tests/**'],
        testCommand: 'CHANGED_FILES="tests/e2e/foo.spec.ts" eval "$TEST_E2E_COMMAND"',
      };
      assert.deepEqual(ts.validateTaskTestScope(task), []);
    });
  });
});

describe('fileMatchesScope', () => {
  it('exact match', () => {
    assert.equal(ts.fileMatchesScope('lib/foo.ts', ['lib/foo.ts']), true);
  });
  it('glob with **', () => {
    assert.equal(ts.fileMatchesScope('lib/foo/bar/baz.ts', ['lib/foo/**']), true);
  });
  it('no match across siblings', () => {
    assert.equal(ts.fileMatchesScope('lib/bar.ts', ['lib/foo.ts']), false);
  });
  it('handles ./ prefix on both sides', () => {
    assert.equal(ts.fileMatchesScope('./lib/foo.ts', ['./lib/foo.ts']), true);
  });
});

describe('findTask', () => {
  it('finds by task num', () => {
    const tasks = [
      { num: 1, filesInScope: ['a'] },
      { num: 2, filesInScope: ['b'] },
    ];
    assert.equal(ts.findTask(tasks, 2).filesInScope[0], 'b');
  });

  it('returns null when not found', () => {
    assert.equal(ts.findTask([{ num: 1 }], 9), null);
  });

  it('returns null for bad input', () => {
    assert.equal(ts.findTask(null, 1), null);
    assert.equal(ts.findTask([{ num: 1 }], 'nope'), null);
  });
});
