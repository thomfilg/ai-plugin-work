'use strict';

/**
 * Task 13 (GH-590) — ECHO-5815 chain reproducer integration test.
 *
 * AC13: chain reproducer (Task A creates a new module, Task B adds one line to a
 * barrel) must produce either a single task or a `wiring-citation` task with a
 * validated peer reference. Test fails on `main` (where the new validators do
 * not exist) and passes once Tasks 6-11 are wired.
 *
 * Three assertions:
 *  1. Flag-on chain WITHOUT wiring-citation → orphan diagnostic on `src/barrel.ts`.
 *  2. Flag-on chain WITH `kind: wiring-citation` + `verified-by: Task 1` whose
 *     entry transitively touches `src/barrel.ts` → passes (no orphan).
 *  3. Flag-off baseline on the same un-wired fixture → does NOT raise the orphan
 *     diagnostic (proves the legacy path would have allowed a fake command).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const draft = require('../../../lib/phases/draft');

function mkTasksDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gh590-task13-'));
}

function writeTasks(dir, body) {
  fs.writeFileSync(path.join(dir, 'tasks.md'), body, 'utf8');
}

function writeSpec(dir, body = '## Component Shape Decision\n\n_No generic split._\n') {
  fs.writeFileSync(path.join(dir, 'spec.md'), body, 'utf8');
}

function writeRepoSkeleton(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/new-module.ts'), '// noop\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'src/barrel.ts'), '// noop\n', 'utf8');
  // A test entry that transitively covers BOTH new-module.ts AND barrel.ts.
  fs.writeFileSync(
    path.join(dir, 'src/new-module.test.ts'),
    "require('./new-module');\nrequire('./barrel');\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'fixture', scripts: { test: 'node --test' } }),
    'utf8'
  );
}

// Chain shape WITHOUT a wiring-citation. Task A owns the new module + its test,
// Task B owns the barrel one-line spread but has its own kind:unit entry that
// does NOT touch the barrel (e.g., points at a placeholder spec). The TDD-
// ownership graph should reject `src/barrel.ts` as orphaned.
const CHAIN_TASKS_MD_ORPHAN = [
  '## Extracted Requirements',
  '',
  '- R1',
  '- R2',
  '',
  '## Task 1 — create new module',
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
  '- adds new module',
  '',
  '### Files in scope',
  '- `src/new-module.ts`',
  '- `src/new-module.test.ts`',
  '',
  '### Test Strategy',
  '```yaml',
  'kind: unit',
  'entry: src/new-module.test.ts',
  '```',
  '',
  '## Task 2 — one-line spread into barrel',
  '',
  '### Type',
  'backend',
  '',
  '### Dependencies',
  'Task 1',
  '',
  '### Requirements Covered',
  '- R2',
  '',
  '### Acceptance Criteria',
  '- wires new module into barrel',
  '',
  '### Files in scope',
  '- `src/barrel.ts`',
  '- `src/barrel-placeholder.test.ts`',
  '',
  '### Test Strategy',
  '```yaml',
  'kind: unit',
  'entry: src/barrel-placeholder.test.ts',
  '```',
  '',
].join('\n');

// Same shape, but Task 2 declares `kind: wiring-citation` against Task 1 whose
// entry (new-module.test.ts) transitively touches src/barrel.ts.
const CHAIN_TASKS_MD_CITATION = [
  '## Extracted Requirements',
  '',
  '- R1',
  '- R2',
  '',
  '## Task 1 — create new module',
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
  '- adds new module',
  '',
  '### Files in scope',
  '- `src/new-module.ts`',
  '- `src/new-module.test.ts`',
  '- `src/barrel.ts`',
  '',
  '### Test Strategy',
  '```yaml',
  'kind: unit',
  'entry: src/new-module.test.ts',
  '```',
  '',
  '## Task 2 — one-line spread into barrel',
  '',
  '### Type',
  'wiring',
  '',
  '### Dependencies',
  'Task 1',
  '',
  '### Requirements Covered',
  '- R2',
  '',
  '### Acceptance Criteria',
  '- wires new module into barrel',
  '',
  '### Files in scope',
  '- `src/barrel.ts`',
  '',
  '### Test Strategy',
  '```yaml',
  'kind: wiring-citation',
  'verified-by: Task 1',
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

test('flag-on: ECHO-5815 chain without wiring-citation raises orphan diagnostic on barrel', () => {
  const dir = mkTasksDir();
  writeSpec(dir);
  writeRepoSkeleton(dir);
  // Task 2's placeholder test entry must exist so command synthesis itself
  // does not flag the file-missing — we want the orphan graph to be the one
  // that fires, not the dispatcher.
  fs.writeFileSync(path.join(dir, 'src/barrel-placeholder.test.ts'), '// noop\n', 'utf8');
  writeTasks(dir, CHAIN_TASKS_MD_ORPHAN);

  const errors = withFlag('1', () => draft.validateArtifacts(dir), dir);
  const joined = errors.join('\n');
  assert.ok(
    /src\/barrel\.ts/.test(joined),
    `expected an orphan diagnostic naming src/barrel.ts; got: ${joined}`
  );
  assert.ok(
    /wiring-citation/.test(joined) || /fold/.test(joined),
    `orphan diagnostic should list the three remediation options (fold / wiring-citation / add test entry); got: ${joined}`
  );
});

test('flag-on: ECHO-5815 chain with wiring-citation peer reference passes', () => {
  const dir = mkTasksDir();
  writeSpec(dir);
  writeRepoSkeleton(dir);
  writeTasks(dir, CHAIN_TASKS_MD_CITATION);

  const errors = withFlag('1', () => draft.validateArtifacts(dir), dir);
  const joined = errors.join('\n');
  assert.ok(
    !/src\/barrel\.ts/.test(joined) || !/orphan/i.test(joined),
    `wiring-citation acceptance path should not raise an orphan diagnostic on src/barrel.ts; got: ${joined}`
  );
  assert.deepEqual(
    errors,
    [],
    `wiring-citation acceptance path should pass cleanly; got: ${JSON.stringify(errors)}`
  );
});

test('flag-off baseline: same un-wired chain does NOT raise the orphan diagnostic', () => {
  const dir = mkTasksDir();
  writeSpec(dir);
  writeRepoSkeleton(dir);
  fs.writeFileSync(path.join(dir, 'src/barrel-placeholder.test.ts'), '// noop\n', 'utf8');
  writeTasks(dir, CHAIN_TASKS_MD_ORPHAN);

  const errors = withFlag('0', () => draft.validateArtifacts(dir));
  const joined = errors.join('\n');
  assert.ok(
    !/orphan/i.test(joined),
    `legacy (flag-off) path must NOT raise the orphan diagnostic — proves baseline would have allowed the fake command path; got: ${joined}`
  );
});
