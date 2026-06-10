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

  it('exempts checkpoint tasks from the Files-in-scope requirement', () => {
    // Checkpoint tasks don't ship code, so they don't need a scope envelope.
    assert.deepEqual(ts.validateTask({ num: 9, type: 'checkpoint' }), []);
    assert.deepEqual(ts.validateTask({ num: 10, isCheckpoint: true }), []);
  });

  // GH-392 follow-up: cross-task deps must be repo-relative.
  it('rejects absolute POSIX path in crossTaskDeps', () => {
    const errors = ts.validateTask({
      num: 11,
      filesInScope: ['src/a.ts'],
      crossTaskDeps: ['/etc/passwd'],
    });
    assert.match(errors.join('|'), /Cross-Task Dependencies.*absolute path/);
    assert.match(errors.join('|'), /\/etc\/passwd/);
  });

  it('rejects absolute Windows path in crossTaskDeps', () => {
    const errors = ts.validateTask({
      num: 12,
      filesInScope: ['src/a.ts'],
      crossTaskDeps: ['C:\\Windows\\System32\\evil.dll'],
    });
    assert.match(errors.join('|'), /Cross-Task Dependencies.*absolute path/);
  });

  it('accepts repo-relative crossTaskDeps', () => {
    const errors = ts.validateTask({
      num: 13,
      filesInScope: ['src/a.ts'],
      crossTaskDeps: ['src/shared/schema.ts', 'lib/**/*.ts'],
    });
    assert.deepEqual(errors, []);
  });

  it('rejects absolute path in filesInScope and filesOutOfScope', () => {
    const errors = ts.validateTask({
      num: 14,
      filesInScope: ['/abs/in.ts'],
      filesOutOfScope: ['/abs/out.ts'],
    });
    assert.match(errors.join('|'), /Files in scope.*absolute path/);
    assert.match(errors.join('|'), /Files explicitly out of scope.*absolute path/);
  });
});

// GH-392 follow-up: cross-task deps must reference paths owned by another task.
describe('validateCrossTaskDepsOwnership', () => {
  it('errors when a crossTaskDep is owned by no other task', () => {
    const tasks = [
      { num: 1, filesInScope: ['src/a.ts'], crossTaskDeps: ['src/orphan.ts'] },
      { num: 2, filesInScope: ['src/b.ts'] },
    ];
    const errors = ts.validateCrossTaskDepsOwnership(tasks);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Task 1 declares Cross-Task Dependency `src\/orphan\.ts`/);
    assert.match(errors[0], /no other task lists it in/);
  });

  it('accepts a crossTaskDep that literally appears in another task\'s scope', () => {
    const tasks = [
      { num: 1, filesInScope: ['src/a.ts'], crossTaskDeps: ['src/shared/schema.ts'] },
      { num: 2, filesInScope: ['src/shared/schema.ts', 'src/b.ts'] },
    ];
    assert.deepEqual(ts.validateCrossTaskDepsOwnership(tasks), []);
  });

  it('accepts a crossTaskDep covered by another task\'s glob scope', () => {
    const tasks = [
      { num: 1, filesInScope: ['src/a.ts'], crossTaskDeps: ['src/shared/schema.ts'] },
      { num: 2, filesInScope: ['src/shared/**'] },
    ];
    assert.deepEqual(ts.validateCrossTaskDepsOwnership(tasks), []);
  });

  it('rejects a crossTaskDep that only the SAME task lists in scope', () => {
    const tasks = [
      {
        num: 1,
        filesInScope: ['src/a.ts', 'src/self.ts'],
        crossTaskDeps: ['src/self.ts'],
      },
      { num: 2, filesInScope: ['src/b.ts'] },
    ];
    const errors = ts.validateCrossTaskDepsOwnership(tasks);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /no other task lists it in/);
  });

  it('validateAll surfaces the cross-task ownership error at tasks-gate', () => {
    const result = ts.validateAll([
      { num: 1, filesInScope: ['src/a.ts'], crossTaskDeps: ['src/orphan.ts'] },
      { num: 2, filesInScope: ['src/b.ts'] },
    ]);
    assert.equal(result.valid, false);
    assert.ok(
      result.errors.some((e) => /Cross-Task Dependency.*orphan/.test(e)),
      `validateAll should surface ownership error; got: ${result.errors.join(' | ')}`
    );
  });

  it('skips absolute entries (already errored by validateTask)', () => {
    const tasks = [
      { num: 1, filesInScope: ['src/a.ts'], crossTaskDeps: ['/etc/passwd'] },
      { num: 2, filesInScope: ['src/b.ts'] },
    ];
    // validateCrossTaskDepsOwnership skips absolute entries; validateTask covers them.
    assert.deepEqual(ts.validateCrossTaskDepsOwnership(tasks), []);
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
        filesInScope: ['lib/foo/**'],
        testCommand: 'CHANGED_FILES="lib/bar/bar.test.ts" eval "$TEST_UNIT_COMMAND"',
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

describe('Rule 4b: testable surface enforcement', () => {
  it('blocks Test Command that is `pnpm typecheck`', () => {
    const task = {
      num: 6,
      filesInScope: ['lib/foo.ts'],
      testCommand: 'pnpm typecheck',
    };
    const errors = ts.validateTaskTestScope(task);
    assert.ok(errors.length >= 1);
    assert.match(errors[0], /typecheck-only/);
    assert.match(errors[0], /Rule 4b/);
  });

  it('blocks Test Command that is `pnpm lint`', () => {
    const task = { num: 7, filesInScope: ['lib/foo.ts'], testCommand: 'pnpm lint --fix' };
    const errors = ts.validateTaskTestScope(task);
    assert.ok(errors.length >= 1);
    assert.match(errors[0], /lint-only/);
  });

  it('blocks Test Command that is `pnpm build`', () => {
    const task = { num: 8, filesInScope: ['lib/foo.ts'], testCommand: 'pnpm build' };
    const errors = ts.validateTaskTestScope(task);
    assert.ok(errors.length >= 1);
    assert.match(errors[0], /build-only/);
  });

  it('blocks Test Command that is `true` (noop)', () => {
    const task = { num: 9, filesInScope: ['lib/foo.ts'], testCommand: 'true' };
    const errors = ts.validateTaskTestScope(task);
    assert.ok(errors.length >= 1);
    assert.match(errors[0], /noop/);
  });

  it('blocks helper-only task: CHANGED_FILES has zero test files', () => {
    // ECHO-4637 Task 6 shape: ships a helper, no test file, integration runner.
    const task = {
      num: 6,
      filesInScope: ['tests/e2e/helpers/external-assets-filter-seed.ts'],
      testCommand:
        'CHANGED_FILES="tests/e2e/helpers/external-assets-filter-seed.ts" eval "$TEST_INTEGRATION_COMMAND"',
    };
    const errors = ts.validateTaskTestScope(task);
    assert.ok(errors.length >= 1);
    assert.match(errors[0], /no test files/i);
    assert.match(errors[0], /Rule 4b/);
  });

  it('exempts checkpoint tasks (type=checkpoint)', () => {
    const task = {
      num: 9,
      type: 'checkpoint',
      filesInScope: ['*.md'],
      testCommand: 'pnpm typecheck',
    };
    assert.deepEqual(ts.validateTaskTestScope(task), []);
  });

  it('exempts checkpoint tasks (isCheckpoint=true)', () => {
    const task = {
      num: 9,
      isCheckpoint: true,
      filesInScope: ['*.md'],
      testCommand: 'true',
    };
    assert.deepEqual(ts.validateTaskTestScope(task), []);
  });

  it('does NOT block hardcoded runner invocations (pnpm test foo.test.ts)', () => {
    const task = {
      num: 1,
      filesInScope: ['lib/foo/**'],
      testCommand: 'pnpm test lib/foo/bar.test.ts',
    };
    // No CHANGED_FILES envelope to parse, so other checks short-circuit. The
    // detectNonTestCommand check must NOT flag `pnpm test` as a non-test cmd.
    assert.deepEqual(ts.validateTaskTestScope(task), []);
  });
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
      assert.match(errors[0], /no declared runner will pick up/i);
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
      assert.match(errors[0], /no declared runner will pick up/i);
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
      assert.match(errors[0], /no declared runner will pick up/i);
    });

    it('blocks $TEST_UNIT_COMMAND when test file IS an e2e test', () => {
      const task = {
        num: 4,
        filesInScope: ['tests/**'],
        testCommand: 'CHANGED_FILES="tests/e2e/foo.spec.ts" eval "$TEST_UNIT_COMMAND"',
      };
      const errors = ts.validateTaskTestScope(task);
      assert.equal(errors.length, 1);
      assert.match(errors[0], /no declared runner will pick up/i);
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

    it('passes multi-suite chained command when each eval has its own CHANGED_FILES (post-bug-#3 fix)', () => {
      // After GH-397 bug #3 fix, each eval MUST be preceded by its own
      // CHANGED_FILES assignment in the same segment — otherwise the second
      // runner executes against the whole repo and the per-task gate is defeated.
      const task = {
        num: 7,
        filesInScope: ['lib/foo/**', 'app/api/**'],
        testCommand:
          'CHANGED_FILES="lib/foo/foo.test.ts" eval "$TEST_UNIT_COMMAND" && CHANGED_FILES="app/api/bar.integration.test.ts" eval "$TEST_INTEGRATION_COMMAND"',
      };
      assert.deepEqual(ts.validateTaskTestScope(task), []);
    });

    it('still blocks when a file matches NO declared runner', () => {
      // Only `$TEST_UNIT_COMMAND` declared, but an integration file is in
      // CHANGED_FILES — unit runner's include pattern won't match it.
      const task = {
        num: 8,
        filesInScope: ['lib/foo/**', 'app/api/**'],
        testCommand:
          'CHANGED_FILES="app/api/bar.integration.test.ts lib/foo/foo.test.ts" eval "$TEST_UNIT_COMMAND"',
      };
      const errors = ts.validateTaskTestScope(task);
      assert.ok(errors.length >= 1);
      assert.match(errors[0], /bar\.integration\.test\.ts/);
    });
  });
});

describe('per-eval CHANGED_FILES validation (Task 3 — bug #3)', () => {
  it('Scenario 6: Test Command with two evals and only one CHANGED_FILES prefix fails validation', () => {
    // Two evals chained with `&&`, only the FIRST has a CHANGED_FILES prefix.
    // The second eval ($TEST_INTEGRATION_COMMAND) is unscoped — it would run
    // the integration runner against ALL files, defeating the per-task gate.
    const task = {
      num: 3,
      filesInScope: ['a.test.ts', 'b.integration.test.ts'],
      testCommand:
        'CHANGED_FILES="a.test.ts" eval "$TEST_UNIT_COMMAND" && eval "$TEST_INTEGRATION_COMMAND"',
    };
    const errors = ts.validateTaskTestScope(task);
    assert.ok(errors.length >= 1, `expected at least one error, got ${errors.length}`);
    const unscoped = errors.find((e) => /\$TEST_INTEGRATION_COMMAND/.test(e));
    assert.ok(unscoped, 'expected error naming the unscoped $TEST_INTEGRATION_COMMAND eval');
  });

  it('Scenario 7: Test Command with one CHANGED_FILES per eval passes validation', () => {
    // Each eval has its own CHANGED_FILES prefix in the same segment — both
    // runners are scoped. Both test files live in `### Files in scope`.
    const task = {
      num: 4,
      filesInScope: ['a.test.ts', 'b.integration.test.ts'],
      testCommand:
        'CHANGED_FILES="a.test.ts" eval "$TEST_UNIT_COMMAND" && CHANGED_FILES="b.integration.test.ts" eval "$TEST_INTEGRATION_COMMAND"',
    };
    assert.deepEqual(ts.validateTaskTestScope(task), []);
  });

  it('Scenario 8: Single-eval Test Command (backward compatible) still passes', () => {
    const task = {
      num: 5,
      filesInScope: ['a.test.ts'],
      testCommand: 'CHANGED_FILES="a.test.ts" eval "$TEST_UNIT_COMMAND"',
    };
    assert.deepEqual(ts.validateTaskTestScope(task), []);
  });

  it('Scenario 9: Two-eval form — second eval CHANGED_FILES references an unscoped file', () => {
    // Both evals have their own CHANGED_FILES prefix (so the per-eval check
    // passes), but the SECOND eval references `app/api/bar.integration.test.ts`
    // which is NOT listed in `### Files in scope`. Downstream scope-membership
    // validation must union both evals' files and flag the offender —
    // otherwise the second runner executes against code owned by a sibling
    // task and the gate deadlocks (ECHO-4637-class).
    const task = {
      num: 6,
      filesInScope: ['a.test.ts'],
      testCommand:
        'CHANGED_FILES="a.test.ts" eval "$TEST_UNIT_COMMAND" && CHANGED_FILES="app/api/bar.integration.test.ts" eval "$TEST_INTEGRATION_COMMAND"',
    };
    const errors = ts.validateTaskTestScope(task);
    assert.ok(
      errors.some(
        (e) => /Files in scope/.test(e) && /app\/api\/bar\.integration\.test\.ts/.test(e)
      ),
      `expected scope-membership error naming the offending file from the second eval; got: ${JSON.stringify(errors)}`
    );
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
  it('mid-glob ** requires tail to match (no prefix-only false-positive)', () => {
    // The previous prefix-match heuristic returned true for ANY file under
    // `lib/` when the scope was `lib/**/foo.ts`. The fixed matcher only
    // accepts paths whose tail also matches.
    assert.equal(ts.fileMatchesScope('lib/unrelated.ts', ['lib/**/foo.ts']), false);
    assert.equal(ts.fileMatchesScope('lib/bar/foo.ts', ['lib/**/foo.ts']), true);
    assert.equal(ts.fileMatchesScope('lib/foo.ts', ['lib/**/foo.ts']), false);
  });
  it('single * does not cross path segments', () => {
    assert.equal(ts.fileMatchesScope('lib/a/b.ts', ['lib/*.ts']), false);
    assert.equal(ts.fileMatchesScope('lib/a.ts', ['lib/*.ts']), true);
  });
  it('trailing slash desugars to directory wildcard', () => {
    assert.equal(ts.fileMatchesScope('lib/foo/bar.ts', ['lib/foo/']), true);
    assert.equal(ts.fileMatchesScope('lib/other.ts', ['lib/foo/']), false);
  });
});

describe('validateTddCycle (ECHO-4453 wedge detection)', () => {
  it('returns no errors on a clean single-cycle task', () => {
    const tasks = [
      {
        num: 1,
        title: 'Backend: derive dashboardCount (full TDD cycle)',
        type: 'backend',
        requirementsCovered: 'R9, spec §IO #1',
      },
    ];
    assert.deepEqual(ts.validateTddCycle(tasks), []);
  });

  it('flags RED-only Task N followed by GREEN-only Task N+1 sharing R-ids', () => {
    const tasks = [
      {
        num: 1,
        title: 'RED: extend get.integration.test.ts with failing assertion',
        type: 'backend',
        requirementsCovered: 'R9, spec §IO #2',
      },
      {
        num: 2,
        title: 'GREEN: derive real dashboardCount in get.ts',
        type: 'backend',
        requirementsCovered: 'R9, spec §IO #1',
      },
    ];
    const errs = ts.validateTddCycle(tasks);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /Task 1 \(RED\) and Task 2 \(GREEN\)/);
    assert.match(errs[0], /R9/);
    assert.match(errs[0], /ECHO-4453 wedge/);
  });

  it('flags GREEN → REFACTOR split too', () => {
    const tasks = [
      {
        num: 1,
        title: 'GREEN: implement derivation',
        type: 'backend',
        requirementsCovered: 'R9',
      },
      {
        num: 2,
        title: 'REFACTOR: tidy reducer',
        type: 'backend',
        requirementsCovered: 'R9',
      },
    ];
    const errs = ts.validateTddCycle(tasks);
    assert.equal(errs.length, 1);
    assert.match(errs[0], /Task 1 \(GREEN\) and Task 2 \(REFACTOR\)/);
  });

  it('does not flag when phase-prefixed tasks cover DIFFERENT requirements', () => {
    const tasks = [
      { num: 1, title: 'RED: scenario A', type: 'backend', requirementsCovered: 'R1' },
      { num: 2, title: 'GREEN: scenario B', type: 'backend', requirementsCovered: 'R2' },
    ];
    assert.deepEqual(ts.validateTddCycle(tasks), []);
  });

  it('does not flag checkpoint tasks', () => {
    const tasks = [
      { num: 1, title: 'RED: write failing test', type: 'backend', requirementsCovered: 'R1' },
      { num: 2, title: 'GREEN: implement', type: 'checkpoint', requirementsCovered: 'R1' },
    ];
    assert.deepEqual(ts.validateTddCycle(tasks), []);
  });

  it('does not flag non-consecutive phase transitions (RED then REFACTOR)', () => {
    const tasks = [
      { num: 1, title: 'RED: foo', type: 'backend', requirementsCovered: 'R1' },
      { num: 2, title: 'REFACTOR: bar', type: 'backend', requirementsCovered: 'R1' },
    ];
    assert.deepEqual(ts.validateTddCycle(tasks), []);
  });

  it('does not flag tasks without phase prefix', () => {
    const tasks = [
      { num: 1, title: 'Add failing test', type: 'backend', requirementsCovered: 'R1' },
      { num: 2, title: 'Implement feature', type: 'backend', requirementsCovered: 'R1' },
    ];
    assert.deepEqual(ts.validateTddCycle(tasks), []);
  });

  it('handles empty input gracefully', () => {
    assert.deepEqual(ts.validateTddCycle([]), []);
    assert.deepEqual(ts.validateTddCycle(null), []);
  });

  it('validateAll includes TDD-cycle errors in aggregated output', () => {
    const tasks = [
      {
        num: 1,
        title: 'RED: failing test',
        type: 'backend',
        filesInScope: ['a.test.ts'],
        requirementsCovered: 'R9',
      },
      {
        num: 2,
        title: 'GREEN: implementation',
        type: 'backend',
        filesInScope: ['a.ts'],
        requirementsCovered: 'R9',
      },
    ];
    const result = ts.validateAll(tasks);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => /ECHO-4453 wedge/.test(e)));
  });
});

describe('validateTaskTestScope: TDD task must own a test file in Files in scope (GH-491 R3/R6)', () => {
  // A TDD-required task whose deliverables/gherkin imply test authorship
  // (e.g. a `**RED:**` phase that adds failing tests) MUST list a
  // `*.test.*` / `*.spec.*` entry in its `### Files in scope`, or the
  // implement-time RED gate has nothing to discover and deadlocks. The
  // authoring-time validator catches this at tasks-gate instead.
  const tddBody =
    'Add a helper folded into validateTaskTestScope.\n' +
    '- 2.1.1 **RED:** Add failing unit tests exercising the new check.\n' +
    '  - Test: Tests fail — the new check does not exist yet.\n' +
    '- 2.1.2 **GREEN:** Implement the helper.\n';

  it('(a) errors when a TDD test-authoring task lists no test file in Files in scope', () => {
    const task = {
      num: 2,
      type: 'tdd-code',
      title: 'Authoring-time guard',
      filesInScope: [
        'plugins/work/scripts/workflows/lib/task-scope-test-validator.js',
        'plugins/work/scripts/workflows/lib/task-scope-validators.js',
      ],
      rawContent: tddBody,
    };
    const errors = ts.validateTaskTestScope(task);
    const owns = errors.find((e) => /Files in scope/.test(e) && /test file|\*\.test|\.spec/i.test(e));
    assert.ok(
      owns,
      `expected an error telling the author to add a test file to Files in scope; got: ${JSON.stringify(errors)}`
    );
    assert.match(owns, /Task 2/);
  });

  it('(b) does NOT error when the TDD task lists a *.test.js in Files in scope', () => {
    const task = {
      num: 2,
      type: 'tdd-code',
      title: 'Authoring-time guard',
      filesInScope: [
        'plugins/work/scripts/workflows/lib/task-scope-test-validator.js',
        'plugins/work/scripts/workflows/lib/__tests__/task-scope.test.js',
      ],
      rawContent: tddBody,
    };
    const errors = ts.validateTaskTestScope(task);
    const owns = errors.find(
      (e) => /Files in scope/.test(e) && /must (own|list).*test|add.*test file/i.test(e)
    );
    assert.equal(
      owns,
      undefined,
      `expected no own-a-test-file error when a test file is in scope; got: ${JSON.stringify(errors)}`
    );
  });

  it('(c) does NOT error for a checkpoint task (type=checkpoint)', () => {
    const task = {
      num: 4,
      type: 'checkpoint',
      title: 'Checkpoint: verify everything',
      filesInScope: ['lib/foo.js'],
      rawContent: tddBody,
    };
    assert.deepEqual(ts.validateTaskTestScope(task), []);
  });

  it('(d) does NOT error for a docs task (type=docs)', () => {
    const task = {
      num: 3,
      type: 'docs',
      title: 'Documentation review',
      filesInScope: ['plugins/work/skills/split-in-tasks/docs/decomposition-rules.md'],
      rawContent:
        'Document the equivalence finding.\n- 3.1 Record the note in decomposition-rules.md.\n',
    };
    const errors = ts.validateTaskTestScope(task);
    const owns = errors.find(
      (e) => /Files in scope/.test(e) && /must (own|list).*test|add.*test file/i.test(e)
    );
    assert.equal(
      owns,
      undefined,
      `docs task must be unaffected by the own-a-test-file guard; got: ${JSON.stringify(errors)}`
    );
  });

  // GH-491 follow-up (cursor[bot]): the authoring-time guard must exempt
  // EXACTLY the Types the implement-time contract (`gateContractFor`) exempts
  // from RED test-file discovery. Types like config / ci / mechanical-refactor
  // / file-move commonly use `**RED:**` for verification commands with no
  // *.test.* in scope, and the implement-time RED gate would NOT deadlock —
  // so the authoring-time guard must NOT flag them.
  const redVerifyBody =
    'Bump the formatter config.\n' +
    '- 5.1.1 **RED:** Run the verification command; confirm it currently fails.\n' +
    '  - Test: `node --test path/to/check` reports the expected pre-change state.\n' +
    '- 5.1.2 **GREEN:** Apply the config change.\n';

  for (const type of ['config', 'ci', 'mechanical-refactor', 'file-move']) {
    it(`(e) does NOT error for a ${type} task using **RED:** with no test file in scope`, () => {
      const task = {
        num: 5,
        type,
        title: `${type} change with RED verification`,
        filesInScope: ['package.json'],
        rawContent: redVerifyBody,
      };
      const errors = ts.validateTaskTestScope(task);
      const owns = errors.find(
        (e) => /Files in scope/.test(e) && /test file|\*\.test|\.spec/i.test(e)
      );
      assert.equal(
        owns,
        undefined,
        `type=${type} is RED-exempt per gateContractFor and must not be flagged by the own-a-test-file guard; got: ${JSON.stringify(errors)}`
      );
    });
  }
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
