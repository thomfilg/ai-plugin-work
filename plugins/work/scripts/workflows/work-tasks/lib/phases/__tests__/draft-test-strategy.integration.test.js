'use strict';

/**
 * Task 11 (GH-590) — integration tests for `draft.js` wiring of
 * `validateTestStrategy` + `validateTddOwnership` behind the
 * `WORK_TEST_STRATEGY_VALIDATOR` feature flag.
 *
 * RED phase: these tests are expected to fail because `draft.js` does not yet
 * export `validateTestStrategy` or `validateTddOwnership`, and `validateArtifacts`
 * does not yet consult them.
 *
 * Covers:
 *  - AC9  (collected failures surfaced through draft phase)
 *  - AC12 (relax cross-task-test rule)
 *  - AC17 (gated on WORK_TEST_STRATEGY_VALIDATOR)
 *  - AC14 (custom body emits dev:typecheck miss + grep resolve)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const draft = require('../../../lib/phases/draft');

function mkTasksDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh590-task11-'));
}

function writeTasks(dir, body) {
  fs.writeFileSync(path.join(dir, 'tasks.md'), body, 'utf8');
}

function writeSpec(dir, body = '## Component Shape Decision\n\n_No generic split._\n') {
  fs.writeFileSync(path.join(dir, 'spec.md'), body, 'utf8');
}

const LEGACY_TASKS_MD = [
  '## Extracted Requirements',
  '',
  '- R1',
  '',
  '## Task 1 — legacy shape with ### Test Command only',
  '',
  '### Type',
  'backend',
  '',
  '### Dependencies',
  'none',
  '',
  '### Requirements Covered',
  '- R1',
  '',
  '### Acceptance Criteria',
  '- does the thing',
  '',
  '### Files in scope',
  '- `src/foo.ts`',
  '- `src/foo.test.ts`',
  '',
  '### Test Command',
  '```bash',
  'CHANGED_FILES="src/foo.test.ts" eval "$TEST_UNIT_COMMAND"',
  '```',
  '',
].join('\n');

const STRATEGY_TASKS_MD_VALID = [
  '## Extracted Requirements',
  '',
  '- R1',
  '',
  '## Task 1 — module under test',
  '',
  '### Type',
  'backend',
  '',
  '### Dependencies',
  'none',
  '',
  '### Requirements Covered',
  '- R1',
  '',
  '### Acceptance Criteria',
  '- does the thing',
  '',
  '### Files in scope',
  '- `src/foo.ts`',
  '- `src/foo.test.ts`',
  '',
  '### Test Strategy',
  '```yaml',
  'kind: unit',
  'entry: src/foo.test.ts',
  '```',
  '',
].join('\n');

const STRATEGY_TASKS_MD_BAD_CUSTOM = [
  '## Extracted Requirements',
  '',
  '- R1',
  '',
  '## Task 1 — custom body that should collect both AC14 errors',
  '',
  '### Type',
  'backend',
  '',
  '### Dependencies',
  'none',
  '',
  '### Requirements Covered',
  '- R1',
  '',
  '### Acceptance Criteria',
  '- does the thing',
  '',
  '### Files in scope',
  '- `bar.ts`',
  '',
  '### Test Strategy',
  '```bash',
  'pnpm dev:typecheck && grep -q foo bar.ts',
  '```',
  '',
].join('\n');

function withFlag(value, fn, workDir) {
  const prev = process.env.WORK_TEST_STRATEGY_VALIDATOR;
  const prevWork = process.env.WORK_DRAFT_WORKDIR;
  if (value === undefined) delete process.env.WORK_TEST_STRATEGY_VALIDATOR;
  else process.env.WORK_TEST_STRATEGY_VALIDATOR = value;
  if (workDir) process.env.WORK_DRAFT_WORKDIR = workDir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.WORK_TEST_STRATEGY_VALIDATOR;
    else process.env.WORK_TEST_STRATEGY_VALIDATOR = prev;
    if (prevWork === undefined) delete process.env.WORK_DRAFT_WORKDIR;
    else process.env.WORK_DRAFT_WORKDIR = prevWork;
  }
}

test('draft.js exports the two new strategy validators (Task 11 wiring)', () => {
  assert.equal(
    typeof draft.validateTestStrategy,
    'function',
    'expected draft.js to export `validateTestStrategy` (Task 11 — wiring)'
  );
  assert.equal(
    typeof draft.validateTddOwnership,
    'function',
    'expected draft.js to export `validateTddOwnership` (Task 11 — wiring)'
  );
});

test('legacy ### Test Command is rejected even with the removed flag set to 0', () => {
  const dir = mkTasksDir();
  writeSpec(dir);
  writeTasks(dir, LEGACY_TASKS_MD);

  const errors = withFlag('0', () => draft.validateArtifacts(dir));
  assert.ok(
    errors.some((e) => /still uses legacy `### Test Command`/.test(e)),
    `expected the migration error; got: ${JSON.stringify(errors)}`
  );
});

test('flag-on: valid kind=unit ### Test Strategy passes draft validation', () => {
  const dir = mkTasksDir();
  writeSpec(dir);
  writeTasks(dir, STRATEGY_TASKS_MD_VALID);
  // Make the entry resolvable so command synthesis does not flag it.
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/foo.test.ts'), '// noop\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }),
    'utf8'
  );

  const errors = withFlag('1', () => draft.validateArtifacts(dir), dir);
  assert.deepEqual(
    errors,
    [],
    `flag-on valid strategy should pass; got: ${JSON.stringify(errors)}`
  );
});

test('flag-on: custom body "pnpm dev:typecheck && grep -q foo bar.ts" emits exactly the dev:typecheck miss (AC6/AC14)', () => {
  const dir = mkTasksDir();
  writeSpec(dir);
  writeTasks(dir, STRATEGY_TASKS_MD_BAD_CUSTOM);
  fs.writeFileSync(path.join(dir, 'bar.ts'), '// noop\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    // Intentionally NO dev:typecheck script — AC14 expects a "missing" error
    // with Levenshtein top-3 nearest matches.
    JSON.stringify({ name: 'fixture', scripts: { test: 'node --test', 'dev:test': 'x' } }),
    'utf8'
  );

  const errors = withFlag('1', () => draft.validateArtifacts(dir), dir);
  const joined = errors.join('\n');
  assert.ok(
    /dev:typecheck/.test(joined),
    `expected an error naming "dev:typecheck" missing from manifest; got: ${joined}`
  );
  // Per AC6 the failure condition for a bare binary is (not on PATH) AND
  // (not declared in package.json deps). `grep` is on PATH, so PATH-
  // resolution alone is sufficient — it must NOT produce an error. The
  // "AC14 confirms grep resolves" is confirmed by the ABSENCE of a grep
  // error, not by emitting a confirmation diagnostic into errors[].
  assert.ok(
    !/grep/.test(joined),
    `grep is on PATH and must not produce an error per AC6; got: ${joined}`
  );
});

const STRATEGY_TASKS_MD_UNIT_NO_ENTRY = [
  '## Extracted Requirements',
  '',
  '- R1',
  '',
  '## Task 1 — kind=unit but no entry line (shape gate must catch this)',
  '',
  '### Type',
  'backend',
  '',
  '### Dependencies',
  'none',
  '',
  '### Requirements Covered',
  '- R1',
  '',
  '### Acceptance Criteria',
  '- does the thing',
  '',
  '### Files in scope',
  '- `src/foo.ts`',
  '',
  '### Test Strategy',
  '```yaml',
  'kind: unit',
  '```',
  '',
].join('\n');

test('flag-on: kind=unit without entry surfaces the shape error via runStrategyValidators', () => {
  const dir = mkTasksDir();
  writeSpec(dir);
  writeTasks(dir, STRATEGY_TASKS_MD_UNIT_NO_ENTRY);
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }),
    'utf8'
  );

  const draftStrategy = require('../draft-test-strategy');
  const errors = withFlag('1', () => draftStrategy.runStrategyValidators(dir), dir);
  const joined = errors.join('\n');
  assert.ok(
    /kind=unit/.test(joined) && /entry/.test(joined),
    `expected shape error naming kind=unit and the missing entry field; got: ${joined}`
  );
});

test('strategy validators run even with the removed flag set to 0', () => {
  const dir = mkTasksDir();
  writeSpec(dir);
  writeTasks(dir, STRATEGY_TASKS_MD_BAD_CUSTOM);
  fs.writeFileSync(path.join(dir, 'bar.ts'), '// noop\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }),
    'utf8'
  );

  const errors = withFlag('0', () => draft.validateArtifacts(dir, { workDir: dir }));
  const joined = errors.join('\n');
  assert.ok(
    /dev:typecheck/.test(joined),
    `validators are always on — expected the dev:typecheck dispatcher miss; got: ${joined}`
  );
});

test('parser-failure surfacing (cursor[bot] 3423427166): flag-on parseTasks failure emits hard error, not silent pass', () => {
  const draftStrategy = require('../draft-test-strategy');
  const prev = process.env.WORK_TEST_STRATEGY_VALIDATOR;
  process.env.WORK_TEST_STRATEGY_VALIDATOR = '1';
  try {
    const errors = draftStrategy.validateTestStrategy('/tmp/nonexistent', {
      parsedTasks: null,
    });
    assert.ok(
      errors.some((e) => /could not parse tasks\.md/i.test(e)),
      `expected parser-failure error, got: ${JSON.stringify(errors)}`
    );
  } finally {
    if (prev === undefined) delete process.env.WORK_TEST_STRATEGY_VALIDATOR;
    else process.env.WORK_TEST_STRATEGY_VALIDATOR = prev;
  }
});

// --- #606 defense: missing verification block -------------------------------

function tasksMdWithoutVerification(type) {
  return [
    '## Extracted Requirements',
    '',
    '- R1',
    '',
    `## Task 1 — ${type} task with no Test Strategy at all`,
    '',
    '### Type',
    type,
    '',
    '### Dependencies',
    'none',
    '',
    '### Requirements Covered',
    '- R1',
    '',
    '### Acceptance Criteria',
    '- content updated',
    '',
    '### Files in scope',
    '- `README.md`',
    '',
  ].join('\n');
}

test('flag-on: docs task with neither Test Strategy nor Test Command is blocked (#606)', () => {
  const dir = mkTasksDir();
  writeSpec(dir);
  writeTasks(dir, tasksMdWithoutVerification('docs'));

  const errors = withFlag('1', () => draft.validateArtifacts(dir), dir);
  const joined = errors.join('\n');
  assert.ok(
    /has neither `### Test Strategy` nor legacy `### Test Command`/.test(joined),
    `expected missing-verification error; got: ${JSON.stringify(errors)}`
  );
  assert.ok(
    /kind: custom/.test(joined),
    `error should carry the docs-task remediation hint; got: ${JSON.stringify(errors)}`
  );
});

test('flag-on: checkpoint task without a Test Strategy stays exempt', () => {
  const dir = mkTasksDir();
  writeSpec(dir);
  writeTasks(dir, tasksMdWithoutVerification('checkpoint'));

  const errors = withFlag('1', () => draft.validateArtifacts(dir), dir);
  assert.ok(
    !errors.some((e) => /has neither/.test(e)),
    `checkpoint should not require a verification block; got: ${JSON.stringify(errors)}`
  );
});

test('missing verification block is enforced even with the removed flag set to 0', () => {
  const dir = mkTasksDir();
  writeSpec(dir);
  writeTasks(dir, tasksMdWithoutVerification('docs'));

  const errors = withFlag('0', () => draft.validateArtifacts(dir));
  assert.ok(
    errors.some((e) => /has neither/.test(e)),
    `validators are always on; got: ${JSON.stringify(errors)}`
  );
});
