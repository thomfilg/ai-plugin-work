'use strict';

/**
 * GH-570 — ablation-RED mode integration tests (`tdd-phase-state.js`).
 *
 * A task that declares `red-mode: ablation` in its `### Test Strategy`
 * records RED by temporarily mutating tracked source so the test command
 * fails (mutationSha = sha256 of the source diff), and records GREEN only
 * after the mutation is reverted (revertSha stamped, `tdd-ablation-cycle`
 * audit row with BOTH shas).
 *
 * Covered:
 *   - RED with mutation + failing command records {ablation, mutationSha,
 *     testFileStateSha, pinnedTestFiles, failingTest}
 *   - RED without a source mutation is rejected
 *   - test-file-only changes do not count as a mutation
 *   - RED with an out-of-scope-only mutation is rejected (adversarial
 *     review: a README-churn "mutation" proves nothing about the task)
 *   - RED without in-scope it()/test() blocks is rejected (mirrors
 *     resume-completed condition b)
 *   - --ablation without the tasks.md declaration is rejected
 *   - --synthesized on an ablation-declared task is rejected
 *   - GREEN after revert records {ablation, revertSha} + audit row
 *   - GREEN with the mutation still applied is rejected
 *   - GREEN with test files edited since RED is rejected (test-pinning:
 *     the sabotage-test-then-restore attack is closed)
 *   - failingTest is best-effort: parsed names when recognizable, null
 *     otherwise
 *
 * Run with:
 *   node --test scripts/workflows/work-implement/__tests__/tdd-phase-state-ablation.integration.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const CLI_PATH = path.join(__dirname, '..', 'tdd-phase-state.js');
const TICKET = 'TEST-ABL1';
const TASK = 1;

let homeDir;
let tasksBase;
let gitRepo;

// The "behavior under test": check.js fails (exit 1) when src/feature.js
// carries the BROKEN marker — i.e. when the ablation mutation is applied.
function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-abl-git-'));
  execSync('git init -q && git config user.email t@t.com && git config user.name T', {
    cwd: dir,
    stdio: 'pipe',
  });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'feature.js'), 'module.exports = () => "works";\n');
  // The pinning-test surface: ablation RED requires in-scope test files with
  // it()/test() blocks on disk (mirrors resume-completed condition b).
  fs.writeFileSync(
    path.join(dir, 'src', 'feature.test.js'),
    "it('pins existing behavior', () => {});\n"
  );
  fs.writeFileSync(
    path.join(dir, 'check.js'),
    [
      "const fs = require('fs');",
      "const s = fs.readFileSync('src/feature.js', 'utf8');",
      // TAP-shaped failure line so the recorder's best-effort failingTest
      // extraction has something recognizable to parse.
      "if (s.includes('BROKEN')) { console.log('not ok 1 - feature pins behavior'); process.exit(1); }",
      "console.log('feature ok');",
    ].join('\n')
  );
  execSync('git add . && git -c commit.gpgsign=false commit -qm init', { cwd: dir, stdio: 'pipe' });
  return dir;
}

function writeTasksMd({ redMode }) {
  const dir = path.join(tasksBase, TICKET);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'tasks.md'),
    [
      '## Task 1 — Pin existing feature behavior',
      '',
      '### Type',
      'tdd-code',
      '',
      '### Files in scope',
      '- src/feature.js',
      '- src/feature.test.js',
      '',
      '### Test Strategy',
      '```',
      'kind: custom',
      'command: node check.js',
      ...(redMode ? [`red-mode: ${redMode}`] : []),
      '```',
      '',
    ].join('\n')
  );
}

function runCli(args) {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    cwd: gitRepo,
    env: {
      ...process.env,
      HOME: homeDir,
      TASKS_BASE: tasksBase,
      WORK_TDD_TOKEN_SKIP: '1',
      WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
    },
  });
  return {
    stdout: res.stdout || '',
    stderr: res.stderr || '',
    exitCode: res.status == null ? 1 : res.status,
  };
}

function readState() {
  const p = path.join(tasksBase, TICKET, `task${TASK}`, 'tdd-phase.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readAuditRows() {
  const p = path.join(tasksBase, TICKET, '.work-actions.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function applyMutation() {
  fs.appendFileSync(path.join(gitRepo, 'src', 'feature.js'), '// BROKEN\n');
}

function revertMutation() {
  execSync('git checkout -- src/feature.js', { cwd: gitRepo, stdio: 'pipe' });
}

function initTask() {
  const init = runCli(['init', TICKET, '--task', String(TASK)]);
  assert.equal(init.exitCode, 0, `init failed: ${init.stderr}`);
}

function recordRed(extra = []) {
  return runCli(['record-red', TICKET, '--task', String(TASK), '--cmd', 'node check.js', ...extra]);
}

describe('GH-570 — ablation-RED mode (tdd-phase-state.js)', () => {
  beforeEach(() => {
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-abl-home-'));
    tasksBase = path.join(homeDir, 'worktrees', 'tasks');
    fs.mkdirSync(tasksBase, { recursive: true });
    gitRepo = createGitFixture();
  });

  afterEach(() => {
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(gitRepo, { recursive: true, force: true });
  });

  it('RED with a source mutation and failing command records ablation evidence with mutationSha', () => {
    writeTasksMd({ redMode: 'ablation' });
    initTask();
    applyMutation();

    const res = recordRed();
    assert.equal(res.exitCode, 0, `expected RED to record: ${res.stderr}\n${res.stdout}`);

    const state = readState();
    const cyc = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(cyc && cyc.red, 'red evidence must be recorded');
    assert.equal(cyc.red.ablation, true);
    assert.match(cyc.red.mutationSha, /^[0-9a-f]{64}$/, 'mutationSha must be a sha256 hex digest');
    assert.ok(cyc.red.testExitCode !== 0, 'red run must have failed');
    assert.deepEqual(cyc.red.mutatedFiles, ['src/feature.js']);
    assert.match(
      cyc.red.testFileStateSha,
      /^[0-9a-f]{64}$/,
      'testFileStateSha must pin the in-scope test files'
    );
    assert.deepEqual(cyc.red.pinnedTestFiles, ['src/feature.test.js']);
    assert.deepEqual(
      cyc.red.failingTest,
      ['feature pins behavior'],
      'failingTest is parsed from the TAP failure line'
    );
    assert.equal(state.currentPhase, 'red', 'record-red does not transition by itself');
  });

  it('RED without a source mutation is rejected', () => {
    writeTasksMd({ redMode: 'ablation' });
    initTask();

    const res = recordRed();
    assert.notEqual(res.exitCode, 0);
    assert.match(res.stderr, /no source mutation detected/);
  });

  it('RED with test-file-only changes is rejected (tests are not a mutation)', () => {
    writeTasksMd({ redMode: 'ablation' });
    initTask();
    // Change a tracked test file only — must NOT count as a source mutation.
    fs.writeFileSync(path.join(gitRepo, 'src', 'feature.test.js'), '// new pinning test\n');
    execSync('git add src/feature.test.js', { cwd: gitRepo, stdio: 'pipe' });

    const res = recordRed();
    assert.notEqual(res.exitCode, 0);
    assert.match(res.stderr, /no source mutation detected/);
  });

  it('RED with an out-of-scope-only mutation is rejected', () => {
    writeTasksMd({ redMode: 'ablation' });
    initTask();
    // check.js is tracked, non-test, and NOT in `### Files in scope` — a
    // trivial diff to it must not qualify as the ablation mutation.
    fs.appendFileSync(path.join(gitRepo, 'check.js'), '// churn\n');

    const res = recordRed();
    assert.notEqual(res.exitCode, 0);
    assert.match(res.stderr, /no mutated source file is inside/);

    const state = readState();
    const cyc = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(!cyc || !cyc.red, 'no evidence may be recorded on rejection');
  });

  it('RED without in-scope it()/test() blocks is rejected', () => {
    writeTasksMd({ redMode: 'ablation' });
    initTask();
    // Strip the pinning test's blocks, keep the file — the ablation cycle
    // exists to prove pinning tests detect the mutation, so an empty test
    // surface voids it.
    fs.writeFileSync(path.join(gitRepo, 'src', 'feature.test.js'), '// no blocks yet\n');
    applyMutation();

    const res = recordRed();
    assert.notEqual(res.exitCode, 0);
    assert.match(res.stderr, /it\(\)\/test\(\) blocks/);
  });

  it('RED records failingTest: null when the runner output is unparseable', () => {
    writeTasksMd({ redMode: 'ablation' });
    initTask();
    applyMutation();
    fs.writeFileSync(
      path.join(gitRepo, 'plain-check.js'),
      [
        "const fs = require('fs');",
        "const s = fs.readFileSync('src/feature.js', 'utf8');",
        "if (s.includes('BROKEN')) { console.log('generic failure'); process.exit(1); }",
        "console.log('feature ok');",
      ].join('\n')
    );

    const res = runCli([
      'record-red',
      TICKET,
      '--task',
      String(TASK),
      '--cmd',
      'node plain-check.js',
    ]);
    assert.equal(res.exitCode, 0, `expected RED to record: ${res.stderr}\n${res.stdout}`);
    const state = readState();
    const cyc = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.equal(cyc.red.failingTest, null, 'unparseable output yields failingTest: null');
  });

  it('--ablation without the tasks.md declaration is rejected', () => {
    writeTasksMd({ redMode: null });
    initTask();
    applyMutation();

    const res = recordRed(['--ablation']);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.stderr, /NOT grantable at execution time/);

    const state = readState();
    const cyc = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(!cyc || !cyc.red, 'no evidence may be recorded on rejection');
  });

  it('--synthesized on an ablation-declared task is rejected', () => {
    writeTasksMd({ redMode: 'ablation' });
    initTask();

    const res = recordRed(['--synthesized', '--reason', 'covered already']);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.stderr, /--synthesized bypass is not allowed/);
  });

  it('GREEN after reverting the mutation records revertSha and the tdd-ablation-cycle audit row', () => {
    writeTasksMd({ redMode: 'ablation' });
    initTask();
    applyMutation();
    const red = recordRed();
    assert.equal(red.exitCode, 0, `RED failed: ${red.stderr}`);
    const mutationSha = readState().cycles[0].red.mutationSha;

    const t = runCli(['transition', TICKET, 'green', '--task', String(TASK)]);
    assert.equal(t.exitCode, 0, `transition failed: ${t.stderr}`);

    revertMutation();
    const green = runCli([
      'record-green',
      TICKET,
      '--task',
      String(TASK),
      '--cmd',
      'node check.js',
    ]);
    assert.equal(green.exitCode, 0, `expected GREEN to record: ${green.stderr}\n${green.stdout}`);

    const state = readState();
    const cyc = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.equal(cyc.green.ablation, true);
    assert.ok(cyc.green.revertSha, 'revertSha must be stamped');
    assert.equal(
      cyc.green.revertSha,
      execSync('git rev-parse HEAD', { cwd: gitRepo, encoding: 'utf8' }).trim(),
      'revertSha is HEAD when git is available'
    );

    const rows = readAuditRows().filter((r) => r && r.action === 'tdd-ablation-cycle');
    assert.equal(rows.length, 1, 'exactly one tdd-ablation-cycle audit row');
    assert.equal(rows[0].meta.mutationSha, mutationSha, 'audit row carries mutationSha');
    assert.equal(rows[0].meta.revertSha, cyc.green.revertSha, 'audit row carries revertSha');
  });

  it('GREEN with the mutation still applied is rejected even when the command passes', () => {
    writeTasksMd({ redMode: 'ablation' });
    initTask();
    applyMutation();
    const red = recordRed();
    assert.equal(red.exitCode, 0, `RED failed: ${red.stderr}`);
    const t = runCli(['transition', TICKET, 'green', '--task', String(TASK)]);
    assert.equal(t.exitCode, 0, `transition failed: ${t.stderr}`);

    // Mutation NOT reverted; use a command that passes anyway to prove the
    // hash check (not the exit code) is what rejects.
    const green = runCli([
      'record-green',
      TICKET,
      '--task',
      String(TASK),
      '--cmd',
      'node -e "console.log(\'ok\')"',
    ]);
    assert.notEqual(green.exitCode, 0);
    assert.match(green.stderr, /mutation is still applied/);

    const rows = readAuditRows().filter((r) => r && r.action === 'tdd-ablation-cycle');
    assert.equal(rows.length, 0, 'no audit row on rejection');
  });

  it('GREEN with test files edited since RED is rejected (test-pinning integrity)', () => {
    writeTasksMd({ redMode: 'ablation' });
    initTask();
    applyMutation();
    const red = recordRed();
    assert.equal(red.exitCode, 0, `RED failed: ${red.stderr}`);
    const t = runCli(['transition', TICKET, 'green', '--task', String(TASK)]);
    assert.equal(t.exitCode, 0, `transition failed: ${t.stderr}`);

    // Sabotage-then-restore attack shape: the test file at GREEN differs
    // from its RED state, so the fail→pass flip is no longer attributable
    // to the reverted source mutation alone.
    revertMutation();
    fs.appendFileSync(
      path.join(gitRepo, 'src', 'feature.test.js'),
      "it('added after RED', () => {});\n"
    );

    const green = runCli([
      'record-green',
      TICKET,
      '--task',
      String(TASK),
      '--cmd',
      'node check.js',
    ]);
    assert.notEqual(green.exitCode, 0);
    assert.match(green.stderr, /byte-identical/);

    const rows = readAuditRows().filter((r) => r && r.action === 'tdd-ablation-cycle');
    assert.equal(rows.length, 0, 'no audit row on rejection');
    const state = readState();
    const cyc = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.ok(!cyc.green, 'no green evidence may be recorded on rejection');
  });
});

describe('GH-570 — extractFailingTestNames (best-effort runner-output parser)', () => {
  const { extractFailingTestNames } = require('../tdd-phase-state/ablation');

  it('parses TAP, node:test spec, jest, and mocha failure lines', () => {
    assert.deepEqual(extractFailingTestNames('not ok 1 - adds numbers\nok 2 - other'), [
      'adds numbers',
    ]);
    assert.deepEqual(extractFailingTestNames('✖ pins behavior (0.8ms)'), ['pins behavior']);
    assert.deepEqual(extractFailingTestNames('  ✕ renders header (12 ms)'), ['renders header']);
    assert.deepEqual(extractFailingTestNames('  1) validates input'), ['validates input']);
  });

  it('dedupes repeated names and returns null for unparseable output', () => {
    assert.deepEqual(extractFailingTestNames('not ok 1 - same\nnot ok 2 - same'), [
      'same',
      // (second line is the same name — deduped)
    ]);
    assert.equal(extractFailingTestNames('everything exploded'), null);
    assert.equal(extractFailingTestNames(''), null);
    assert.equal(extractFailingTestNames(null), null);
  });
});
