'use strict';

/**
 * task-next.js / tdd-phase-state.js — `--resume-completed` machine-verified
 * resume path (GH-509).
 *
 * Covered end-to-end (spawned CLIs, real git fixture repos):
 *   1. Implementation + tests committed on the branch, command passes ⇒
 *      `--resume-completed` records a complete `resumedCompleted` cycle,
 *      derived phase is done, and a `tdd-resume-completed` audit row lands
 *      with HEAD sha + matched commit sha(s).
 *   2. Uncommitted work ⇒ rejected, condition (d) named, no evidence written.
 *   3. No in-scope test blocks ⇒ rejected, condition (b) named.
 *   4. Existing cycles ⇒ rejected, condition (a) named.
 *   5. Failing command ⇒ rejected, condition (c) named.
 *   6. RED "exits 0" block message surfaces the flag when (a)+(b)+(d) hold,
 *      and does NOT surface it when there are no scope commits.
 *   7. Citation-kind tasks reject the flag explicitly.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TASK_NEXT = path.resolve(__dirname, '..', 'task-next.js');
const STATE_FILENAME = 'tdd' + '-phase' + '.json';
const ACTIONS_FILENAME = '.work' + '-actions' + '.json';
const TICKET = 'TEST-509';

const PASSING_TEST = [
  "const test = require('node:test');",
  "const assert = require('node:assert/strict');",
  "const { add } = require('./feature');",
  "test('adds two numbers', () => { assert.equal(add(1, 2), 3); });",
  '',
].join('\n');

function git(repoRoot, args) {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return (r.stdout || '').trim();
}

function initRepo() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-next-resume-repo-'));
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
  git(repoRoot, ['config', 'user.email', 't@t']);
  git(repoRoot, ['config', 'user.name', 't']);
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# seed\n');
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-q', '-m', 'seed']);
  return repoRoot;
}

/** Write impl + (optionally broken) test under lib/ WITHOUT committing. */
function writeImpl(repoRoot, { broken = false, withTest = true } = {}) {
  fs.mkdirSync(path.join(repoRoot, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(repoRoot, 'lib', 'feature.js'),
    broken
      ? 'module.exports = { add: (a, b) => a - b };\n'
      : 'module.exports = { add: (a, b) => a + b };\n'
  );
  if (withTest) {
    fs.writeFileSync(path.join(repoRoot, 'lib', 'feature.test.js'), PASSING_TEST);
  }
}

function commitAll(repoRoot, msg) {
  git(repoRoot, ['add', '.']);
  git(repoRoot, ['commit', '-q', '-m', msg]);
  return git(repoRoot, ['rev-parse', 'HEAD']);
}

function writeTasks(tasksBase, strategyLines) {
  fs.mkdirSync(path.join(tasksBase, TICKET), { recursive: true });
  fs.writeFileSync(
    path.join(tasksBase, TICKET, 'tasks.md'),
    [
      '# Tasks',
      '',
      '## Task 1 — add feature',
      '',
      '### Type',
      'tdd-code',
      '',
      '### Files in scope',
      '- lib/feature.js',
      '- lib/feature.test.js',
      '',
      '### Test Strategy',
      '```',
      ...strategyLines,
      '```',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(tasksBase, TICKET, '.work' + '-state.json'),
    JSON.stringify({ ticketId: TICKET })
  );
}

function customStrategy() {
  return ['kind: custom', 'command: node --test lib/feature.test.js'];
}

function runTaskNext(tasksBase, repoRoot, args = [], taskId = 'task1') {
  const env = {
    ...process.env,
    TASKS_BASE: tasksBase,
    WORK_TDD_TOKEN_SKIP: '1',
    WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
  };
  // Real agent invocations don't run under a node:test parent; leaking
  // NODE_TEST_CONTEXT flips inner `node --test` runs into the child-runner
  // protocol. BASE_BRANCH must not leak either — the fixture's base is main.
  delete env.NODE_TEST_CONTEXT;
  delete env.BASE_BRANCH;
  return spawnSync('node', [TASK_NEXT, TICKET, taskId, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    env,
  });
}

function readState(tasksBase) {
  const p = path.join(tasksBase, TICKET, 'task1', STATE_FILENAME);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readActions(tasksBase) {
  const p = path.join(tasksBase, TICKET, ACTIONS_FILENAME);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function stateHasEvidence(state) {
  const cycles = (state && state.cycles) || [];
  return cycles.some((c) => c && (c.red || c.green || c.refactor));
}

let tasksBase;
let repoRoot;
beforeEach(() => {
  tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'task-next-resume-'));
  repoRoot = initRepo();
});
afterEach(() => {
  fs.rmSync(tasksBase, { recursive: true, force: true });
  fs.rmSync(repoRoot, { recursive: true, force: true });
});

describe('--resume-completed — committed impl + passing tests (GH-509 happy path)', () => {
  it('records a complete resumedCompleted cycle with HEAD sha and audit row', () => {
    writeTasks(tasksBase, customStrategy());
    git(repoRoot, ['checkout', '-q', '-b', 'feat']);
    writeImpl(repoRoot);
    const implSha = commitAll(repoRoot, 'feat: add feature (prior session)');

    const r = runTaskNext(tasksBase, repoRoot, ['--resume-completed']);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /resume-completed cycle recorded/);
    assert.match(r.stdout, /Task 1 complete/);

    const state = readState(tasksBase);
    const cycle = state.cycles[state.cycles.length - 1];
    assert.equal(cycle.resumedCompleted, true);
    assert.equal(cycle.red.resumedCompleted, true);
    assert.equal(cycle.red.skipped, true);
    assert.equal(cycle.green.testExitCode, 0);
    assert.equal(cycle.green.headSha, implSha);
    assert.equal(cycle.refactor.resumedCompleted, true);
    assert.equal(state.currentPhase, 'refactor');

    const rows = readActions(tasksBase).filter((a) => a.action === 'tdd-resume-completed');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].allow, true);
    assert.equal(rows[0].meta.headSha, implSha);
    assert.ok(rows[0].meta.matchedCommits.includes(implSha));
    assert.ok(rows[0].meta.testBlockCount >= 1);
  });

  it('is idempotent-safe: a second invocation reports done without re-recording', () => {
    writeTasks(tasksBase, customStrategy());
    git(repoRoot, ['checkout', '-q', '-b', 'feat']);
    writeImpl(repoRoot);
    commitAll(repoRoot, 'feat: add feature');

    assert.equal(runTaskNext(tasksBase, repoRoot, ['--resume-completed']).status, 0);
    const again = runTaskNext(tasksBase, repoRoot, ['--resume-completed']);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /Task 1 complete/);
    const state = readState(tasksBase);
    assert.equal(state.cycles.length, 1);
    assert.equal(
      readActions(tasksBase).filter((a) => a.action === 'tdd-resume-completed').length,
      1
    );
  });
});

describe('--resume-completed — rejections name the failed condition', () => {
  it('condition (d): uncommitted work does not qualify', () => {
    writeTasks(tasksBase, customStrategy());
    git(repoRoot, ['checkout', '-q', '-b', 'feat']);
    writeImpl(repoRoot); // on disk, never committed

    const r = runTaskNext(tasksBase, repoRoot, ['--resume-completed']);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /condition \(d\) failed/);
    assert.match(r.stdout, /Uncommitted work does not qualify/);
    assert.equal(stateHasEvidence(readState(tasksBase)), false);
    assert.equal(
      readActions(tasksBase).filter((a) => a.action === 'tdd-resume-completed').length,
      0
    );
  });

  it('condition (b): no in-scope test file with it()/test() blocks', () => {
    writeTasks(tasksBase, customStrategy());
    git(repoRoot, ['checkout', '-q', '-b', 'feat']);
    writeImpl(repoRoot, { withTest: false });
    commitAll(repoRoot, 'feat: impl only, no tests');

    const r = runTaskNext(tasksBase, repoRoot, ['--resume-completed']);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /condition \(b\) failed/);
    assert.equal(stateHasEvidence(readState(tasksBase)), false);
  });

  it('condition (a): completed (green) evidence rejects the resume path', () => {
    writeTasks(tasksBase, customStrategy());
    git(repoRoot, ['checkout', '-q', '-b', 'feat']);
    writeImpl(repoRoot);
    commitAll(repoRoot, 'feat: add feature');
    const taskDir = path.join(tasksBase, TICKET, 'task1');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, STATE_FILENAME),
      JSON.stringify({
        currentPhase: 'green',
        currentCycle: 1,
        cycles: [
          {
            cycle: 1,
            red: { testCommand: 'x', testExitCode: 1, timestamp: '2026-01-01T00:00:00.000Z' },
            green: { testCommand: 'x', testExitCode: 0, timestamp: '2026-01-01T00:01:00.000Z' },
          },
        ],
      })
    );

    const r = runTaskNext(tasksBase, repoRoot, ['--resume-completed']);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /condition \(a\) failed/);
    assert.match(r.stdout, /green\/refactor evidence/);
    // Pre-existing evidence untouched.
    const state = readState(tasksBase);
    assert.equal(state.cycles.length, 1);
    assert.equal(state.cycles[0].green.testExitCode, 0);
    assert.equal(state.cycles[0].refactor, undefined);
  });

  it('GH-509 field case: stale red-only evidence is superseded, not rejected', () => {
    writeTasks(tasksBase, customStrategy());
    git(repoRoot, ['checkout', '-q', '-b', 'feat']);
    writeImpl(repoRoot);
    const implSha = commitAll(repoRoot, 'feat: add feature (prior session)');
    // The GH-504 observed wedge shape: red cycle 1 with a stale recorded
    // testExitCode: 1, testFiles: [] and no green/refactor.
    const taskDir = path.join(tasksBase, TICKET, 'task1');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, STATE_FILENAME),
      JSON.stringify({
        currentPhase: 'red',
        currentCycle: 1,
        cycles: [
          {
            cycle: 1,
            red: {
              testCommand: 'x',
              testExitCode: 1,
              testFiles: [],
              timestamp: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
      })
    );

    // The RED "exits 0" block must surface the resume hint despite the
    // stale red (the suppression predicate tolerates red-only now).
    const blocked = runTaskNext(tasksBase, repoRoot);
    assert.equal(blocked.status, 2);
    assert.match(blocked.stdout, /Possible RESUME detected/);

    const r = runTaskNext(tasksBase, repoRoot, ['--resume-completed']);
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    const state = readState(tasksBase);
    const cycle = state.cycles[state.cycles.length - 1];
    assert.equal(cycle.resumedCompleted, true);
    assert.equal(cycle.red.resumedCompleted, true, 'stale red is superseded in place');
    assert.equal(cycle.green.headSha, implSha);

    const rows = readActions(tasksBase).filter((a) => a.action === 'tdd-resume-completed');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].meta.supersededStaleRed, true);
    assert.equal(rows[0].meta.staleRedCycle, 1);
    assert.equal(rows[0].meta.staleRedTimestamp, '2026-01-01T00:00:00.000Z');
  });

  it('condition (c): failing test command rejects the resume path', () => {
    writeTasks(tasksBase, customStrategy());
    git(repoRoot, ['checkout', '-q', '-b', 'feat']);
    writeImpl(repoRoot, { broken: true });
    commitAll(repoRoot, 'feat: broken impl');

    const r = runTaskNext(tasksBase, repoRoot, ['--resume-completed']);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /condition \(c\) failed/);
    assert.equal(stateHasEvidence(readState(tasksBase)), false);
  });

  it('citation-kind strategies reject the flag explicitly', () => {
    fs.mkdirSync(path.join(tasksBase, TICKET), { recursive: true });
    fs.writeFileSync(
      path.join(tasksBase, TICKET, 'tasks.md'),
      [
        '# Tasks',
        '',
        '## Task 1 — peer with real tests',
        '',
        '### Type',
        'tdd-code',
        '',
        '### Files in scope',
        '- lib/feature.js',
        '- lib/feature.test.js',
        '',
        '### Test Strategy',
        '```',
        ...customStrategy(),
        '```',
        '',
        '## Task 2 — wiring covered by peer',
        '',
        '### Type',
        'tdd-code',
        '',
        '### Files in scope',
        '- lib/feature.js',
        '',
        '### Test Strategy',
        '```',
        'kind: verified-by',
        'peer: Task 1',
        '```',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tasksBase, TICKET, '.work' + '-state.json'),
      JSON.stringify({ ticketId: TICKET })
    );
    git(repoRoot, ['checkout', '-q', '-b', 'feat']);
    writeImpl(repoRoot);
    commitAll(repoRoot, 'feat: add feature');

    const r = runTaskNext(tasksBase, repoRoot, ['--resume-completed'], 'task2');
    assert.equal(r.status, 2);
    assert.match(r.stdout, /--resume-completed requires a runnable test command/);
  });
});

describe('record-resume-completed — the recorder verifies --cmd, never trusts the caller', () => {
  const TDD_CLI = path.resolve(__dirname, '..', 'tdd' + '-phase' + '-state.js');

  function runTdd(args) {
    const env = {
      ...process.env,
      TASKS_BASE: tasksBase,
      WORK_TDD_TOKEN_SKIP: '1',
      WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.BASE_BRANCH;
    return spawnSync('node', [TDD_CLI, ...args], { cwd: repoRoot, encoding: 'utf8', env });
  }

  function seedCommittedImpl() {
    writeTasks(tasksBase, customStrategy());
    git(repoRoot, ['checkout', '-q', '-b', 'feat']);
    writeImpl(repoRoot);
    commitAll(repoRoot, 'feat: add feature (prior session)');
    assert.equal(runTdd(['init', TICKET, '--task', '1']).status, 0);
  }

  it('rejects a --cmd that does not match the strategy-resolved command', () => {
    seedCommittedImpl();
    // Adversarial shape: a vacuous in-repo test runner instead of the
    // task's declared command (would pass FAKE_CMD_PATTERNS).
    fs.writeFileSync(
      path.join(repoRoot, 'lib', 'vacuous.test.js'),
      "const test = require('node:test');\ntest('vacuous', () => {});\n"
    );

    const r = runTdd([
      'record-resume-completed',
      TICKET,
      '--task',
      '1',
      '--cmd',
      'node --test lib/vacuous.test.js',
    ]);
    assert.notEqual(r.status, 0, `expected rejection\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /does not match the strategy-resolved test command/);
    assert.equal(stateHasEvidence(readState(tasksBase)), false, 'no evidence recorded');
    assert.equal(
      readActions(tasksBase).filter((a) => a.action === 'tdd-resume-completed').length,
      0
    );
  });

  it('accepts the exact strategy-resolved command when invoked directly', () => {
    seedCommittedImpl();
    const r = runTdd([
      'record-resume-completed',
      TICKET,
      '--task',
      '1',
      '--cmd',
      'node --test lib/feature.test.js',
    ]);
    assert.equal(r.status, 0, `expected success\n${r.stdout}\n${r.stderr}`);
    assert.equal(stateHasEvidence(readState(tasksBase)), true);
  });
});

describe('RED "exits 0" block message — resume hint surfacing', () => {
  it('surfaces --resume-completed when tests + scope commits exist', () => {
    writeTasks(tasksBase, customStrategy());
    git(repoRoot, ['checkout', '-q', '-b', 'feat']);
    writeImpl(repoRoot);
    commitAll(repoRoot, 'feat: add feature (prior session)');

    const r = runTaskNext(tasksBase, repoRoot);
    assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /Your test command exits 0/);
    assert.match(r.stdout, /Possible RESUME detected/);
    assert.match(r.stdout, /--resume-completed/);
    assert.equal(stateHasEvidence(readState(tasksBase)), false);
  });

  it('does NOT surface the hint without branch commits touching scope', () => {
    writeTasks(tasksBase, customStrategy());
    // Stay on main: tests exist and pass, but main..HEAD is empty.
    writeImpl(repoRoot);
    commitAll(repoRoot, 'seed impl on base branch');

    const r = runTaskNext(tasksBase, repoRoot);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /Your test command exits 0/);
    assert.doesNotMatch(r.stdout, /--resume-completed/);
  });
});
