'use strict';

/**
 * GH-570 — task-next.js integration with `red-mode: ablation` tasks.
 *
 * Covered:
 *   - RED with a passing command on an ablation task blocks with the
 *     ablation guidance (mutate source, do NOT invert assertions) instead
 *     of the generic "rewrite the assertion" message.
 *   - RED with the mutation applied (command fails) records ablation
 *     evidence THROUGH the recorder (red.ablation + mutationSha) and
 *     advances to green — task-next needs no extra flag; the recorder
 *     auto-elevates from the tasks.md declaration.
 *
 * Run with:
 *   node --test scripts/workflows/work-implement/__tests__/task-next-ablation.integration.test.js
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TASK_NEXT = path.resolve(__dirname, '..', 'task-next.js');
const TDD_CLI = path.resolve(__dirname, '..', 'tdd-phase-state.js');
const TICKET = 'TEST-ABLTN';

let tasksBase;
let repo;

function setupGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-abl-repo-'));
  execSync('git init -q && git config user.email t@t.com && git config user.name T', {
    cwd: dir,
    stdio: 'pipe',
    shell: '/bin/bash',
  });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'feature.js'), 'module.exports = () => "works";\n');
  // The pinning test surface — countTestBlocksInFiles needs an it() block.
  fs.writeFileSync(
    path.join(dir, 'src', 'feature.test.js'),
    "it('pins existing behavior', () => {});\n"
  );
  fs.writeFileSync(
    path.join(dir, 'check.js'),
    [
      "const fs = require('fs');",
      "const s = fs.readFileSync('src/feature.js', 'utf8');",
      "if (s.includes('BROKEN')) { console.log('feature broken'); process.exit(1); }",
      "console.log('feature ok');",
    ].join('\n')
  );
  execSync('git add . && git -c commit.gpgsign=false commit -qm init', {
    cwd: dir,
    stdio: 'pipe',
    shell: '/bin/bash',
  });
  return dir;
}

function writeTasksMd() {
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
      'red-mode: ablation',
      '```',
      '',
    ].join('\n')
  );
}

function childEnv() {
  return {
    ...process.env,
    TASKS_BASE: tasksBase,
    WORK_TDD_TOKEN_SKIP: '1',
    WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
    HOME: process.env.HOME || '/tmp',
  };
}

function runTaskNext() {
  const r = spawnSync('node', [TASK_NEXT, TICKET, 'task1'], {
    cwd: repo,
    encoding: 'utf8',
    env: childEnv(),
  });
  return {
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    exitCode: r.status == null ? 1 : r.status,
  };
}

function initState() {
  const r = spawnSync('node', [TDD_CLI, 'init', TICKET, '--task', '1'], {
    cwd: repo,
    encoding: 'utf8',
    env: childEnv(),
  });
  assert.equal(r.status, 0, `init failed: ${r.stderr}`);
}

function readPhaseState() {
  const p = path.join(tasksBase, TICKET, 'task1', 'tdd-phase.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('GH-570 — task-next.js on red-mode: ablation tasks', () => {
  beforeEach(() => {
    tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tn-abl-tasks-'));
    repo = setupGitRepo();
    writeTasksMd();
    initState();
  });

  afterEach(() => {
    fs.rmSync(tasksBase, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('blocks a passing RED run with the ablation guidance, not the invert-assertion message', () => {
    const res = runTaskNext();
    assert.equal(res.exitCode, 2, `expected block: ${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /red-mode: ablation/);
    assert.match(res.stdout, /TEMPORARY mutation/);
    assert.match(res.stdout, /Do NOT invert assertions/);
    assert.doesNotMatch(
      res.stdout,
      /Rewrite the assertion so it actually fails/,
      'generic RED-passed guidance must not appear for ablation tasks'
    );
  });

  it('records ablation RED through the recorder and advances to green when the mutation is applied', () => {
    fs.appendFileSync(path.join(repo, 'src', 'feature.js'), '// BROKEN\n');

    const res = runTaskNext();
    assert.equal(res.exitCode, 0, `expected advance: ${res.stdout}\n${res.stderr}`);
    assert.match(res.stdout, /ADVANCED → green/);

    const state = readPhaseState();
    const cyc = state.cycles.find((c) => c.cycle === state.currentCycle);
    assert.equal(cyc.red.ablation, true, 'recorder must auto-elevate to the ablation path');
    assert.match(cyc.red.mutationSha, /^[0-9a-f]{64}$/);
    assert.equal(state.currentPhase, 'green');
  });
});
