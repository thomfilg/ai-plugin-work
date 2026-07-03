'use strict';

/**
 * task-next.js — Test-Strategy-native command resolution (GH-653).
 *
 * The runner resolves its command from `### Test Strategy` via the SAME
 * shared resolver the implement gate uses. Covered end-to-end:
 *
 *   1. kind: custom docs task traverses RED (command fails pre-edit) →
 *      GREEN (passes post-edit) — the GH-606 repro inverted.
 *   2. kind: unit synthesizes the entry-scoped envelope command, byte-for-byte
 *      identical to the gate resolver's readTaskTestCommand.
 *   3. citation kind (verified-by) — task-next demands no runnable command
 *      and defers to the recorder's peer-evidence path.
 *   4. a stray legacy `### Test Command` block is ignored.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TASK_NEXT = path.resolve(__dirname, '..', 'task-next.js');
const { readTaskTestCommand } = require(
  path.resolve(
    __dirname,
    '..',
    '..',
    'work',
    'lib',
    'step-enrichments',
    'implement-gate',
    'test-command'
  )
);
const STATE_FILENAME = 'tdd' + '-phase' + '.json';
const TICKET = 'TEST-653';

function initRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-next-ts-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# seed\n');
  spawnSync('git', ['add', '.'], { cwd: repoRoot });
  spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoRoot });
  return repoRoot;
}

function writeTasks(tasksBase, taskBlocks) {
  fs.mkdirSync(path.join(tasksBase, TICKET), { recursive: true });
  fs.writeFileSync(path.join(tasksBase, TICKET, 'tasks.md'), taskBlocks.join('\n'));
  fs.writeFileSync(
    path.join(tasksBase, TICKET, '.work' + '-state.json'),
    JSON.stringify({ ticketId: TICKET })
  );
}

function runTaskNext(tasksBase, repoRoot, taskId = 'task1') {
  const env = {
    ...process.env,
    TASKS_BASE: tasksBase,
    WORK_TDD_TOKEN_SKIP: '1',
    WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
  };
  // Real agent invocations don't run under a node:test parent. If we leak
  // NODE_TEST_CONTEXT into the spawned tree, an inner `node --test <file>`
  // switches to the child-runner protocol and exits 0 even on failure,
  // corrupting the RED assertion.
  delete env.NODE_TEST_CONTEXT;
  return spawnSync('node', [TASK_NEXT, TICKET, taskId], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
}

function readState(tasksBase, taskId = 'task1') {
  const p = path.join(tasksBase, TICKET, taskId, STATE_FILENAME);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

let tasksBase;
let repoRoot;
beforeEach(() => {
  tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'task-next-ts-'));
  repoRoot = initRepo();
});
afterEach(() => {
  fs.rmSync(tasksBase, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('task-next.js — kind: custom docs task RED→GREEN (GH-606 inverted)', () => {
  const docPath = 'docs/canonical.md';

  beforeEach(() => {
    writeTasks(tasksBase, [
      '# Tasks',
      '',
      '## Task 1 — document the new flag',
      '',
      '### Type',
      'docs',
      '',
      '### Files in scope',
      `- ${docPath}`,
      '',
      '### Test Strategy',
      '```',
      'kind: custom',
      `command: grep -c "New Flag Section" ${docPath}`,
      '```',
      '',
    ]);
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, docPath), '# Canonical doc\n\nNothing yet.\n');
  });

  it('RED accepts when the custom command fails pre-edit (no MODULE_NOT_FOUND loop)', () => {
    const r = runTaskNext(tasksBase, repoRoot);
    assert.equal(r.status, 0, `expected 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /RED accepted via .*docs-exempt fallback/);
    // The custom command ran — not a node --test fallback over empty CHANGED_FILES.
    assert.match(r.stdout, /grep -c "New Flag Section"/);
    assert.doesNotMatch(r.stdout, /MODULE_NOT_FOUND/);
    const state = readState(tasksBase);
    assert.equal(state.currentPhase, 'green');
    assert.ok(state.cycles.find((c) => c.cycle === 1).red);
  });

  it('GREEN accepts once the doc contains the asserted content, then REFACTOR completes', () => {
    runTaskNext(tasksBase, repoRoot); // RED
    fs.appendFileSync(path.join(repoRoot, docPath), '\n## New Flag Section\n\nDocumented.\n');
    const green = runTaskNext(tasksBase, repoRoot);
    assert.equal(green.status, 0, `expected 0; stdout=${green.stdout} stderr=${green.stderr}`);
    assert.match(green.stdout, /ADVANCED → refactor/);
    const refactor = runTaskNext(tasksBase, repoRoot);
    assert.equal(
      refactor.status,
      0,
      `expected 0; stdout=${refactor.stdout} stderr=${refactor.stderr}`
    );
    const state = readState(tasksBase);
    const cycle = state.cycles.find((c) => c.cycle === 1);
    assert.ok(cycle.red && cycle.green && cycle.refactor, 'full cycle recorded');
  });
});

describe('task-next.js — kind: unit synthesizes the entry-scoped envelope command', () => {
  beforeEach(() => {
    fs.writeFileSync(
      path.join(repoRoot, '.envrc'),
      'export TEST_UNIT_COMMAND="node --test $CHANGED_FILES"\n'
    );
    writeTasks(tasksBase, [
      '# Tasks',
      '',
      '## Task 1 — add foo',
      '',
      '### Type',
      'tdd-code',
      '',
      '### Files in scope',
      '- src/foo.js',
      '- src/foo.test.js',
      '',
      '### Test Strategy',
      '```',
      'kind: unit',
      'entry: src/foo.test.js',
      '```',
      '',
    ]);
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  });

  it('runs CHANGED_FILES="<entry>" eval "$TEST_UNIT_COMMAND" — matching the gate resolver byte-for-byte', () => {
    // Failing test file → RED should record and advance.
    fs.writeFileSync(
      path.join(repoRoot, 'src', 'foo.test.js'),
      'const { test } = require("node:test");\nconst assert = require("node:assert");\ntest("fails", () => { assert.equal(1, 2); });\n'
    );
    const expected = readTaskTestCommand(path.join(tasksBase, TICKET), 1, repoRoot);
    assert.equal(expected, 'CHANGED_FILES="src/foo.test.js" eval "$TEST_UNIT_COMMAND"');

    const r = runTaskNext(tasksBase, repoRoot);
    assert.equal(r.status, 0, `expected 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(
      r.stdout.includes(`test cmd:   ${expected}`),
      `runner must execute the gate resolver's exact command; stdout=${r.stdout}`
    );
    assert.match(r.stdout, /ADVANCED → green/);
  });
});

describe('task-next.js — citation kind defers to the recorder peer-evidence path', () => {
  beforeEach(() => {
    writeTasks(tasksBase, [
      '# Tasks',
      '',
      '## Task 1 — peer with real tests',
      '',
      '### Type',
      'tdd-code',
      '',
      '### Files in scope',
      '- src/wiring.js',
      '- src/wiring.test.js',
      '',
      '### Test Strategy',
      '```',
      'kind: unit',
      'entry: src/wiring.test.js',
      '```',
      '',
      '## Task 2 — wiring covered by peer',
      '',
      '### Type',
      'tdd-code',
      '',
      '### Files in scope',
      '- src/wiring.js',
      '',
      '### Test Strategy',
      '```',
      'kind: verified-by',
      'peer: Task 1',
      '```',
      '',
    ]);
  });

  it('does not demand a runnable command; recorder phase assertion surfaces when not in green', () => {
    const r = runTaskNext(tasksBase, repoRoot, 'task2');
    // Fresh state is in red — the recorder refuses citation green there. task-next
    // must surface that (exit 2) rather than dying on "no command" or running
    // node --test over an empty CHANGED_FILES.
    assert.equal(r.status, 2, `expected 2; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /citation-kind strategy: kind=verified-by/);
    assert.doesNotMatch(r.stdout + r.stderr, /No runnable command resolved/);
    assert.doesNotMatch(r.stdout + r.stderr, /MODULE_NOT_FOUND/);
  });

  it('records peer-citation GREEN via the recorder once the state is in green phase', () => {
    // Seed green phase with red evidence, mirroring the recorder integration
    // suite's seedGreenPhase (the red half is owned by the gate flow).
    runTaskNext(tasksBase, repoRoot, 'task2'); // auto-inits state (blocked in red)
    const sp = path.join(tasksBase, TICKET, 'task2', STATE_FILENAME);
    const state = JSON.parse(fs.readFileSync(sp, 'utf8'));
    state.currentPhase = 'green';
    state.cycles = [
      {
        cycle: 1,
        red: {
          testFiles: ['src/wiring.test.js'],
          testCommand: 'false',
          testExitCode: 1,
          timestamp: new Date().toISOString(),
        },
      },
    ];
    fs.writeFileSync(sp, JSON.stringify(state, null, 2));

    const r = runTaskNext(tasksBase, repoRoot, 'task2');
    assert.equal(r.status, 0, `expected 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stdout, /peer-citation GREEN recorded via kind=verified-by/);
    const after = readState(tasksBase, 'task2');
    const cycle = after.cycles.find((c) => c.cycle === 1);
    assert.equal(cycle.green.kind, 'verified-by');
    assert.equal(cycle.green.peer, 'Task 1');

    // Re-invocation must be idempotent and terminal: the citation is already
    // recorded, so the runner reports the task complete instead of
    // re-recording the same green entry forever (PR #654 review, greptile P1).
    const again = runTaskNext(tasksBase, repoRoot, 'task2');
    assert.equal(again.status, 0, `expected 0; stdout=${again.stdout} stderr=${again.stderr}`);
    assert.match(again.stdout, /peer-citation GREEN already recorded/);
    assert.match(again.stdout, /Task 2 complete/);
    const rerecorded = readState(tasksBase, 'task2');
    assert.equal(
      rerecorded.cycles.find((c) => c.cycle === 1).green.recordedAt,
      cycle.green.recordedAt,
      'green evidence must not be re-written on re-invocation'
    );
  });
});

describe('task-next.js — stray legacy ### Test Command block is ignored', () => {
  it('resolves from ### Test Strategy even when a legacy block is present', () => {
    writeTasks(tasksBase, [
      '# Tasks',
      '',
      '## Task 1 — task with stray legacy block',
      '',
      '### Type',
      'docs',
      '',
      '### Files in scope',
      '- docs/x.md',
      '',
      '### Test Command',
      '```bash',
      'echo legacy-should-not-run && exit 0',
      '```',
      '',
      '### Test Strategy',
      '```',
      'kind: custom',
      'command: grep -c "must-exist" docs/x.md',
      '```',
      '',
    ]);
    fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'docs', 'x.md'), 'empty\n');

    const r = runTaskNext(tasksBase, repoRoot);
    assert.equal(r.status, 0, `expected 0; stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(
      r.stdout.includes('test cmd:   grep -c "must-exist" docs/x.md'),
      `strategy command must win; stdout=${r.stdout}`
    );
    assert.doesNotMatch(r.stdout, /legacy-should-not-run/);
    assert.match(r.stdout, /RED accepted via .*docs-exempt fallback/);
  });
});
