'use strict';

/**
 * task-next.js — Type=tests-only must NOT disable the RC-D empty-output trap.
 *
 * Regression for GH-528 review comment #3 (cursor[bot]):
 *
 *   The GREEN branch for Type=tests-only used to call recordEvidence with
 *   `docsExempt: true`, which forwards `--docs-exempt` to tdd-phase-state.js
 *   and disables the RC-D empty-output trap. Per `gateContractFor('tests-only')`
 *   the contract is `rcdEmptyTrap: true` — a silent verifier such as `true`
 *   (exit 0, no stdout/stderr) must therefore be REJECTED at GREEN even when
 *   an in-scope test file has been modified.
 *
 *   This test wires a silent verifier (`true`), modifies an in-scope test
 *   file (so the tests-only "must-modify" check passes), and asserts that
 *   GREEN recording is rejected by the RC-D trap.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TASK_NEXT = path.resolve(__dirname, '..', 'task-next.js');
const TICKET = 'TEST-528-RCD';

function makeWorkspace({ scope, testCmd }) {
  const tasksBase = fs.mkdtempSync(path.join(os.tmpdir(), 'task-next-to-rcd-'));
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-next-to-rcd-repo-'));
  spawnSync('git', ['init', '-q'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.email', 't@t'], { cwd: repoRoot });
  spawnSync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# seed\n');
  spawnSync('git', ['add', '.'], { cwd: repoRoot });
  spawnSync('git', ['commit', '-q', '-m', 'seed'], { cwd: repoRoot });

  fs.mkdirSync(path.join(tasksBase, TICKET), { recursive: true });
  const md = [
    '# Tasks',
    '',
    '## Task 1 — add coverage',
    '',
    '### Type',
    'tests-only',
    '',
    '### Files in scope',
    ...scope.map((s) => `- ${s}`),
    '',
    '### Test Command',
    '```bash',
    testCmd,
    '```',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(tasksBase, TICKET, 'tasks.md'), md);
  fs.writeFileSync(
    path.join(tasksBase, TICKET, '.work' + '-state.json'),
    JSON.stringify({ ticketId: TICKET })
  );
  return { tasksBase, repoRoot };
}

function runTaskNext(tasksBase, repoRoot) {
  return spawnSync('node', [TASK_NEXT, TICKET, 'task1'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      TASKS_BASE: tasksBase,
      WORK_TDD_TOKEN_SKIP: '1',
      WORK_TDD_SKIP_WORKSPACE_CHECK: '1',
    },
  });
}

describe('task-next.js — tests-only GREEN must NOT disable RC-D empty-output trap', () => {
  let ws;
  beforeEach(() => {
    // Silent verifier: `node -e ""` exits 0 with no stdout/stderr (and is
    // not on the FAKE_CMD_PATTERNS list, so it gets past the parseCmd
    // pre-check). Without the RC-D trap, this records GREEN even though
    // nothing was actually verified. gateContractFor('tests-only')
    // has rcdEmptyTrap=true, so the trap MUST reject.
    ws = makeWorkspace({ scope: ['src/foo.test.js'], testCmd: 'node -e ""' });
    fs.mkdirSync(path.join(ws.repoRoot, 'src'), { recursive: true });
  });
  afterEach(() => {
    if (ws) {
      fs.rmSync(ws.tasksBase, { recursive: true, force: true });
      fs.rmSync(ws.repoRoot, { recursive: true, force: true });
    }
  });

  it('rejects GREEN when verifier is silent (exit 0, no output)', () => {
    // Step 1: skip RED via the tests-only contract.
    const skip = runTaskNext(ws.tasksBase, ws.repoRoot);
    assert.equal(skip.status, 0, `RED-skip failed; stdout=${skip.stdout} stderr=${skip.stderr}`);

    // Step 2: modify an in-scope test file so the "must-modify" check passes.
    fs.writeFileSync(
      path.join(ws.repoRoot, 'src', 'foo.test.js'),
      'const { test } = require("node:test");\ntest("x", () => {});\n'
    );

    // Step 3: re-invoke for GREEN. Verifier is `true` (silent). RC-D
    // empty-output trap must reject — task-next must exit non-zero.
    const r = runTaskNext(ws.tasksBase, ws.repoRoot);
    assert.notEqual(
      r.status,
      0,
      `tests-only GREEN MUST reject silent verifier via RC-D, but exited 0. ` +
        `stdout=${r.stdout} stderr=${r.stderr}`
    );
    // Surface the RC-D rejection diagnostic so the operator sees what fired.
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.match(
      combined,
      /empty-command trap|NO stdout\/stderr|Could not record GREEN evidence/i,
      `expected RC-D trap diagnostic; got: ${combined}`
    );
  });
});
