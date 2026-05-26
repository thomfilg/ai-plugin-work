'use strict';

/**
 * Task 10 — Integration: end-to-end orchestrator recovery from an
 * immediately-passing RED.
 *
 * Drives `task-next.js` + `tdd-phase-state.js record-red --synthesized` end
 * to end via child_process.spawnSync, simulating a `/work implement` step
 * where the very first test command passes immediately and the developer
 * agent uses the synthesized-cycle bypass to recover.
 *
 * Scenario (verbatim from tasks.md + gherkin.feature lines 84–91):
 *   - end-to-end orchestrator recovery from an immediately-passing RED
 *
 * Asserts:
 *   (a) first `task-next.js` after the bypass shows the RED→GREEN
 *       transition succeeded (state file currentPhase is now green and the
 *       follow-up invocation reports phase GREEN).
 *   (b) second `task-next.js` shows phase GREEN and actually runs the
 *       GREEN test command.
 *   (c) `.work-actions.json` contains exactly one
 *       `action: 'tdd-synthesized-cycle'` row for this task num.
 *
 * Run with:
 *   node --test scripts/workflows/work-implement/__tests__/synthesized-cycle-orchestrator.integration.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TASK_NEXT = path.resolve(__dirname, '..', 'task-next.js');
const TDD_CLI = path.resolve(__dirname, '..', 'tdd-phase-state.js');

const TASK_NUM = 1;
const TICKET = 'TEST-ORCH1';
const SCENARIO = 'end-to-end orchestrator recovery from an immediately-passing RED';

// ---------- helpers ----------

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupGitRepo() {
  const repo = makeTmp('orch-int-repo-');
  execSync('git init -q', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email t@t.com && git config user.name T', {
    cwd: repo,
    stdio: 'pipe',
    shell: '/bin/bash',
  });
  fs.writeFileSync(path.join(repo, 'README.md'), 'init\n');
  execSync('git add . && git ' + 'commit -q -m init', {
    cwd: repo,
    stdio: 'pipe',
    shell: '/bin/bash',
  });
  return repo;
}

/**
 * Stage an immediately-passing colocated test file under `src/`. The test
 * uses the gherkin scenario name verbatim as its `test()` title so that
 * task-next.js's RED scenario coverage check is satisfied.
 */
function writePassingTestFile(repo) {
  const srcDir = path.join(repo, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'feature.js'), '// source under test\n');
  fs.writeFileSync(
    path.join(srcDir, 'feature.test.js'),
    [
      "const test = require('node:test');",
      "test('" + SCENARIO + "', () => { /* passes immediately */ });",
      '',
    ].join('\n')
  );
  execSync('git add .', { cwd: repo, stdio: 'pipe' });
}

function writeTasksMd(tasksDir, repo) {
  const colocated = path.relative(
    repo,
    path.join(repo, 'src', 'feature.test.js')
  );
  const source = path.relative(repo, path.join(repo, 'src', 'feature.js'));
  const md = [
    '# Tasks',
    '',
    '## Task ' + TASK_NUM + ' — Synthesized recovery integration fixture',
    '',
    '### Type',
    'wiring',
    '',
    '### Description',
    'Fixture task for the synthesized-cycle orchestrator integration test.',
    '',
    '### Suggested Scope',
    '- ' + source,
    '- ' + colocated,
    '',
    '### Test Command',
    '```bash',
    'node --test ' + colocated,
    '```',
    '',
    '### Scenarios',
    '- ' + SCENARIO,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(tasksDir, 'tasks.md'), md);
}

function writeGherkin(tasksDir) {
  const feat = [
    'Feature: Synthesized cycle orchestrator integration',
    '',
    '  @task:' + TASK_NUM,
    '  Scenario: ' + SCENARIO,
    '    Given a fixture',
    '    When the bypass runs',
    '    Then phase advances',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(tasksDir, 'gherkin.feature'), feat);
}

function childEnv(tasksBase) {
  return {
    ...process.env,
    TASKS_BASE: tasksBase,
    WORK_TDD_TOKEN_SKIP: '1',
    WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
    // task-next.js logs telemetry to a writable location; keep it tmp-local.
    HOME: process.env.HOME || '/tmp',
  };
}

function runTaskNext(tasksBase, cwd) {
  const r = spawnSync('node', [TASK_NEXT, TICKET, 'task' + TASK_NUM], {
    cwd,
    encoding: 'utf8',
    env: childEnv(tasksBase),
  });
  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    exitCode: r.status == null ? 1 : r.status,
  };
}

function runTddInit(tasksBase, cwd) {
  const r = spawnSync(
    'node',
    [TDD_CLI, 'init', TICKET, '--task', String(TASK_NUM)],
    { cwd, encoding: 'utf8', env: childEnv(tasksBase) }
  );
  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    exitCode: r.status == null ? 1 : r.status,
  };
}

function runTddRecordRedSynthesized(tasksBase, cwd, cmd, reason) {
  const r = spawnSync(
    'node',
    [
      TDD_CLI,
      'record-red',
      TICKET,
      '--task',
      String(TASK_NUM),
      '--cmd',
      cmd,
      '--synthesized',
      '--reason',
      reason,
    ],
    { cwd, encoding: 'utf8', env: childEnv(tasksBase) }
  );
  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    exitCode: r.status == null ? 1 : r.status,
  };
}

function readPhaseState(tasksBase) {
  const p = path.join(tasksBase, TICKET, 'task' + TASK_NUM, 'tdd-phase.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function readActions(tasksBase) {
  const p = path.join(tasksBase, TICKET, '.work-actions.json');
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ---------- the scenario ----------

describe('synthesized-cycle orchestrator integration', () => {
  let tasksBaseDir; // contains <TICKET>/tasks.md, gherkin.feature, etc.
  let tasksBase;
  let repo;

  beforeEach(() => {
    tasksBaseDir = makeTmp('orch-int-tasks-');
    tasksBase = tasksBaseDir;
    fs.mkdirSync(path.join(tasksBase, TICKET), { recursive: true });

    repo = setupGitRepo();
    writePassingTestFile(repo);
    writeTasksMd(path.join(tasksBase, TICKET), repo);
    writeGherkin(path.join(tasksBase, TICKET));

    const init = runTddInit(tasksBase, repo);
    assert.equal(
      init.exitCode,
      0,
      'init failed: ' + init.stderr + ' / ' + init.stdout
    );
  });

  afterEach(() => {
    fs.rmSync(tasksBaseDir, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('end-to-end orchestrator recovery from an immediately-passing RED', () => {
    // (a) Pre-bypass sanity: task-next.js sees the test pass immediately
    //     and must BLOCK in red (cannot legitimately record RED evidence).
    const pre = runTaskNext(tasksBase, repo);
    assert.notEqual(
      pre.exitCode,
      0,
      'expected task-next.js to BLOCK in red when the test passes immediately. ' +
        'stdout:\n' +
        pre.stdout +
        '\nstderr:\n' +
        pre.stderr
    );
    assert.match(
      pre.stdout,
      /BLOCKED in red|RED requires a real failing test/,
      'expected pre-bypass output to indicate RED block, got:\n' + pre.stdout
    );

    // The developer agent invokes the synthesized-cycle bypass with a
    // justification. The supplied --cmd is the same passing test command.
    const passingCmd =
      'node --test ' + path.join('src', 'feature.test.js');
    const reason =
      'regression backfill: pre-existing test already covers this behavior';
    const bypass = runTddRecordRedSynthesized(
      tasksBase,
      repo,
      passingCmd,
      reason
    );
    assert.equal(
      bypass.exitCode,
      0,
      'synthesized bypass failed: ' +
        bypass.stderr +
        ' / ' +
        bypass.stdout
    );

    // State must now be green on disk (bypass transitions red → green).
    const stateAfterBypass = readPhaseState(tasksBase);
    assert.equal(
      stateAfterBypass.currentPhase,
      'green',
      'expected currentPhase=green after synthesized bypass, got ' +
        stateAfterBypass.currentPhase
    );

    // (b) Next task-next.js invocation reports GREEN phase and runs the
    //     GREEN test command (which passes), advancing to refactor.
    const post = runTaskNext(tasksBase, repo);
    assert.equal(
      post.exitCode,
      0,
      'expected task-next.js to advance from GREEN, got exit=' +
        post.exitCode +
        '\nstdout:\n' +
        post.stdout +
        '\nstderr:\n' +
        post.stderr
    );
    // The header must surface the GREEN phase (either as the phase that
    // ran or as ADVANCED → refactor).
    assert.match(
      post.stdout,
      /ADVANCED → refactor|# GREEN phase|phase: green|in green/i,
      'expected post-bypass output to mention the GREEN phase, got:\n' +
        post.stdout
    );
    // And it must have actually executed the GREEN test command — the
    // header line is `  test cmd:   <cmd>` followed by `  ran: exit=0`.
    assert.match(
      post.stdout,
      /test cmd:\s+node --test .*feature\.test\.js/,
      'expected post-bypass output to show the resolved GREEN test cmd, got:\n' +
        post.stdout
    );
    assert.match(
      post.stdout,
      /ran:\s+exit=0/,
      'expected post-bypass invocation to record the test as passing (exit=0), got:\n' +
        post.stdout
    );

    // (c) Exactly one tdd-synthesized-cycle audit row for this task.
    const rows = readActions(tasksBase);
    const synRows = rows.filter(
      (r) =>
        r &&
        r.action === 'tdd-synthesized-cycle' &&
        (r.task === TASK_NUM || r.task == null)
    );
    assert.equal(
      synRows.length,
      1,
      'expected exactly one tdd-synthesized-cycle audit row for task ' +
        TASK_NUM +
        ', got ' +
        synRows.length +
        ': ' +
        JSON.stringify(rows, null, 2)
    );
    assert.equal(
      synRows[0].reason,
      reason,
      'audit row must carry the supplied reason'
    );
  });
});
