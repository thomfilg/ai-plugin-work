'use strict';

/**
 * Pass D — Type/AC/Scope Consistency unit tests.
 *
 * Each violation = one kind-D warning. These tests cover every per-Type
 * branch added in GH-528 follow-up (item 2):
 *   - tdd-code: scope must include ≥1 test file AND ≥1 source file
 *   - tests-only: scope must contain ONLY *.test.* / *.spec.*; AC must not
 *     describe new behavior
 *   - docs: scope must be ONLY *.md; AC must not promise behavior changes
 *   - config: scope must match the config allowlist in task-types.js
 *   - ci: scope must match .github/** etc.
 *   - unknown Type: warns
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  lintAllPassD,
  lintTypeAcConsistency,
  parseFilesInScope,
} = require('../lib/lint-type-ac-consistency');

function buildModel({ type, acLines = [], scope = [], number = 1, file = 'tasks.md' }) {
  const lines = [
    `## Task ${number} — sample`,
    '',
    '### Type',
    type,
    '',
    '### Acceptance Criteria',
    ...acLines.map((l) => `- ${l}`),
    '',
    '### Files in scope',
    ...scope.map((s) => `- ${s}`),
    '',
  ];
  return {
    file,
    tasks: [
      {
        number,
        section: lines.join('\n'),
        acceptanceCriteria: acLines,
      },
    ],
  };
}

describe('Pass D — tdd-code contract', () => {
  it('warns when scope has no test file', () => {
    const ws = lintAllPassD(
      buildModel({ type: 'tdd-code', scope: ['src/foo.js'], acLines: ['Behavior X'] })
    );
    const messages = ws.map((w) => w.message).join('\n');
    assert.match(messages, /no `\*\.test\.\*`/);
  });

  it('warns when scope has no source file', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'tdd-code',
        scope: ['src/foo.test.js'],
        acLines: ['Behavior X'],
      })
    );
    const messages = ws.map((w) => w.message).join('\n');
    assert.match(messages, /no non-test source file/);
  });

  it('happy path — both test + source in scope', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'tdd-code',
        scope: ['src/foo.js', 'src/foo.test.js'],
        acLines: ['Behavior X'],
      })
    );
    assert.equal(ws.length, 0, `expected zero warnings, got: ${JSON.stringify(ws)}`);
  });
});

describe('Pass D — tests-only contract', () => {
  it('warns when scope is empty', () => {
    const ws = lintAllPassD(
      buildModel({ type: 'tests-only', scope: [], acLines: ['cover existing behavior'] })
    );
    assert.ok(
      ws.some((w) => /Files in scope` is empty/.test(w.message)),
      `expected empty-scope warning; got ${JSON.stringify(ws)}`
    );
  });

  it('warns when scope includes source files', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'tests-only',
        scope: ['src/foo.test.js', 'src/foo.js'],
        acLines: ['cover existing behavior'],
      })
    );
    assert.ok(ws.some((w) => /non-test file/.test(w.message)));
  });

  it('warns when AC describes new behavior', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'tests-only',
        scope: ['src/foo.test.js'],
        acLines: ['implement feature X'],
      })
    );
    assert.ok(ws.some((w) => /new behavior/.test(w.message)));
  });

  it('happy path — only test file + existing-behavior AC', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'tests-only',
        scope: ['src/foo.test.js'],
        acLines: ['cover existing reducer branch on undefined input'],
      })
    );
    assert.equal(ws.length, 0, `expected zero warnings; got ${JSON.stringify(ws)}`);
  });

  // GH-528 cursor[bot] follow-up: Pass D must use the same scope classifier
  // as the implement-time gate (scopeEntryAdmitsOnlyTestFiles). Globs whose
  // basename constrains to test files (e.g. `src/**\/*.test.js`) admit ONLY
  // test files and must NOT trigger the non-test-file warning at plan time —
  // otherwise valid tasks fail Step 5 while implementation would accept them.
  it('does not warn on a test-constrained glob scope (src/**/*.test.js)', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'tests-only',
        scope: ['src/**/*.test.js'],
        acLines: ['cover existing branch'],
      })
    );
    const offenders = ws.filter((w) => /non-test file/.test(w.message));
    assert.equal(
      offenders.length,
      0,
      `expected no non-test-file warning for glob scope; got ${JSON.stringify(offenders)}`
    );
  });

  it('does not warn on **/*.spec.ts glob', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'tests-only',
        scope: ['**/*.spec.ts'],
        acLines: ['cover existing branch'],
      })
    );
    const offenders = ws.filter((w) => /non-test file/.test(w.message));
    assert.equal(offenders.length, 0, `got ${JSON.stringify(offenders)}`);
  });

  it('does not warn on nested test glob (src/foo/**/*.test.js)', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'tests-only',
        scope: ['src/foo/**/*.test.js'],
        acLines: ['cover existing branch'],
      })
    );
    const offenders = ws.filter((w) => /non-test file/.test(w.message));
    assert.equal(offenders.length, 0, `got ${JSON.stringify(offenders)}`);
  });

  it('STILL warns on open-ended glob that admits non-tests (src/**)', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'tests-only',
        scope: ['src/**'],
        acLines: ['cover existing branch'],
      })
    );
    assert.ok(
      ws.some((w) => /non-test file/.test(w.message)),
      `expected non-test-file warning for open-ended glob; got ${JSON.stringify(ws)}`
    );
  });
});

describe('Pass D — docs contract', () => {
  it('warns when scope includes non-.md files', () => {
    const ws = lintAllPassD(
      buildModel({ type: 'docs', scope: ['README.md', 'src/foo.js'], acLines: ['update README'] })
    );
    assert.ok(ws.some((w) => /non-`\.md`/.test(w.message)));
  });

  it('warns when AC promises new behavior', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'docs',
        scope: ['README.md'],
        acLines: ['implement new endpoint'],
      })
    );
    assert.ok(ws.some((w) => /promises behavior change/.test(w.message)));
  });

  it('happy path — only .md + doc AC', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'docs',
        scope: ['README.md'],
        acLines: ['document the migration steps'],
      })
    );
    assert.equal(ws.length, 0, `expected zero warnings; got ${JSON.stringify(ws)}`);
  });
});

describe('Pass D — config allowlist', () => {
  it('happy path — package.json / tsconfig.json in scope', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'config',
        scope: ['package.json', 'tsconfig.json', '.eslintrc.json'],
        acLines: ['bump strict to true'],
      })
    );
    assert.equal(ws.length, 0, `expected zero warnings; got ${JSON.stringify(ws)}`);
  });

  it('warns when scope includes runtime source', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'config',
        scope: ['package.json', 'src/server.js'],
        acLines: ['bump version'],
      })
    );
    assert.ok(
      ws.some((w) => /outside the config allowlist/.test(w.message)),
      `expected allowlist warning; got ${JSON.stringify(ws)}`
    );
  });
});

describe('Pass D — ci allowlist', () => {
  it('happy path — .github/workflows/*', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'ci',
        scope: ['.github/workflows/ci.yml'],
        acLines: ['add quality job'],
      })
    );
    assert.equal(ws.length, 0, `expected zero warnings; got ${JSON.stringify(ws)}`);
  });

  it('warns when scope includes src/', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'ci',
        scope: ['.github/workflows/ci.yml', 'src/server.js'],
        acLines: ['add CI job'],
      })
    );
    assert.ok(ws.some((w) => /outside the ci allowlist/.test(w.message)));
  });
});

describe('Pass D — unknown Type', () => {
  it('warns on Type=wiring (not in closed taxonomy)', () => {
    const ws = lintAllPassD(
      buildModel({ type: 'wiring', scope: ['src/a.js'], acLines: ['do stuff'] })
    );
    assert.ok(
      ws.some((w) => /closed taxonomy/.test(w.message)),
      `expected unknown-Type warning; got ${JSON.stringify(ws)}`
    );
  });

  it('does not warn on tdd-code (known)', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'tdd-code',
        scope: ['src/a.js', 'src/a.test.js'],
        acLines: ['cover'],
      })
    );
    const unknown = ws.filter((w) => /closed taxonomy/.test(w.message));
    assert.equal(unknown.length, 0);
  });
});

describe('Pass D — docs-exemption phrase retained', () => {
  it('Type=tdd-code with docs-exemption AC still warns "propose Type: docs"', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'tdd-code',
        scope: ['src/a.js', 'src/a.test.js'],
        acLines: ['docs-only update'],
      })
    );
    assert.ok(
      ws.some((w) => w.hint === 'propose Type: docs'),
      `expected docs-exemption warning; got ${JSON.stringify(ws)}`
    );
  });
});

describe('Pass D — lintTypeAcConsistency backward compat', () => {
  it('still returns a single warning for legacy callers', () => {
    const w = lintTypeAcConsistency(
      buildModel({
        type: 'wiring',
        scope: ['src/a.js'],
        acLines: ['documentation/manifest only'],
      })
    );
    assert.ok(w);
    assert.equal(w.kind, 'D');
    assert.equal(w.hint, 'propose Type: docs');
  });

  it('returns null when no warnings', () => {
    const w = lintTypeAcConsistency(
      buildModel({
        type: 'tdd-code',
        scope: ['src/a.js', 'src/a.test.js'],
        acLines: ['cover behavior'],
      })
    );
    assert.equal(w, null);
  });
});

// GH-528 round-2 follow-up ITEM 4: tune acForbidNewBehavior regex.
//
// Strategy (a): NEW_BEHAVIOR_PATTERNS now only checks the first AC bullet
// (the summary line). Supporting bullets can legitimately use low-level
// verbs like "implement"/"fix" — e.g. mechanical-refactor describing
// "implement the rename across N import paths".
//
// Boundary cases:
//   - First bullet describes the task's purpose → patterns fire (warn).
//   - Supporting bullets use refactor-safe phrasings → patterns DO NOT fire.
describe('Pass D — acForbidNewBehavior scoped to summary line (ITEM 4)', () => {
  it('TRUE positive: first AC bullet says "implement the new /users endpoint" → warns (tests-only)', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'tests-only',
        scope: ['src/foo.test.js'],
        acLines: ['implement the new /users endpoint', 'verify status codes'],
      })
    );
    assert.ok(
      ws.some((w) => /new behavior/.test(w.message)),
      `expected new-behavior warning; got ${JSON.stringify(ws)}`
    );
  });

  it('TRUE positive: first AC bullet says "add a feature flag for X" → warns (docs)', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'docs',
        scope: ['README.md'],
        acLines: ['add a feature flag for X', 'document toggle'],
      })
    );
    assert.ok(
      ws.some((w) => /promises behavior change/.test(w.message)),
      `expected behavior-change warning; got ${JSON.stringify(ws)}`
    );
  });

  it('TRUE positive: first AC bullet says "fix the auth-token expiry bug" → warns (tests-only)', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'tests-only',
        scope: ['src/auth.test.js'],
        acLines: ['fix the auth-token expiry bug', 'add coverage'],
      })
    );
    assert.ok(
      ws.some((w) => /new behavior/.test(w.message)),
      `expected new-behavior warning; got ${JSON.stringify(ws)}`
    );
  });

  it('FALSE positive STOPS: supporting bullet says "implement the rename across 18 import paths" (mechanical-refactor)', () => {
    // First bullet (the summary) is refactor-safe; "implement" appears only
    // in a supporting bullet, which is now ignored by the regex.
    const ws = lintAllPassD(
      buildModel({
        type: 'mechanical-refactor',
        scope: ['src/foo.js', 'src/bar.js'],
        acLines: [
          'rename `oldName` to `newName` codebase-wide',
          'implement the rename across 18 import paths',
        ],
      })
    );
    assert.equal(
      ws.filter((w) => /new behavior|behavior change/.test(w.message)).length,
      0,
      `mechanical-refactor supporting bullet should NOT warn; got ${JSON.stringify(ws)}`
    );
  });

  it('FALSE positive STOPS: supporting bullet says "fix the import paths in callers after the move" (file-move)', () => {
    const ws = lintAllPassD(
      buildModel({
        type: 'file-move',
        scope: ['src/old/foo.js', 'src/new/foo.js'],
        acLines: [
          'move `src/old/foo.js` to `src/new/foo.js`',
          'fix the import paths in callers after the move',
        ],
      })
    );
    assert.equal(
      ws.filter((w) => /new behavior|behavior change/.test(w.message)).length,
      0,
      `file-move supporting bullet should NOT warn; got ${JSON.stringify(ws)}`
    );
  });

  it('FALSE positive STOPS: tests-only with summary "add coverage for the existing X behavior"', () => {
    // "add" alone is not in NEW_BEHAVIOR_PATTERNS (the pattern is
    // `add (a/new) (feature|endpoint|api|capability)`); verify this stays
    // true and the summary line is refactor-safe.
    const ws = lintAllPassD(
      buildModel({
        type: 'tests-only',
        scope: ['src/foo.test.js'],
        acLines: ['add coverage for the existing X behavior', 'cover undefined-input branch'],
      })
    );
    assert.equal(
      ws.filter((w) => /new behavior/.test(w.message)).length,
      0,
      `existing-behavior wording should NOT warn; got ${JSON.stringify(ws)}`
    );
  });
});

describe('Pass D — parseFilesInScope helper', () => {
  it('reads bulleted scope entries, strips backticks and trailing comments', () => {
    const section = [
      '## Task 1',
      '',
      '### Files in scope',
      '- `src/foo.js`',
      '- src/bar.js  # owned by Task 1',
      '- src/baz.js',
      '',
      '### Files explicitly out of scope',
      '- src/other.js',
    ].join('\n');
    const out = parseFilesInScope(section);
    assert.deepEqual(out, ['src/foo.js', 'src/bar.js', 'src/baz.js']);
  });
});
