'use strict';

/**
 * Regression test for the auto-init-on-record fix in recordEvidence
 * (task-next.js, commit ea27b7f6).
 *
 * Walks the full RED → GREEN → REFACTOR cycle via direct spawn of
 * task-next.js against a temp-dir synthetic ticket. Proves:
 *   1. First record (RED) auto-inits the per-task tdd-phase.json
 *      (no manual `init` needed).
 *   2. Subsequent records (GREEN, REFACTOR) do NOT re-init (cycle
 *      history is preserved across phases).
 *   3. Final tdd-phase.json carries evidence for all three phases.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const TASK_NEXT = path.resolve(__dirname, '..', 'task-next.js');
const TOKEN_DIR = '/tmp/.claude-write-tokens';

function mintToken(scriptBasename) {
  fs.mkdirSync(TOKEN_DIR, { recursive: true, mode: 0o700 });
  const tp = path.join(TOKEN_DIR, scriptBasename);
  fs.writeFileSync(
    tp,
    JSON.stringify({
      agent: 'developer-nodejs-tdd',
      timestamp: Date.now(),
      tasksBase: null,
    }),
    { mode: 0o600 }
  );
  return tp;
}

function runTaskNext(ticket, taskArg, env) {
  // Mint tokens before invoking — task-next.js will consume them via
  // its companion script chain. The hook normally mints these for us
  // when an authorized agent invokes the script, but tests spawn it
  // directly so we pre-mint.
  mintToken('task-next.js');
  mintToken('tdd-phase-state.js');
  return spawnSync(process.execPath, [TASK_NEXT, ticket, taskArg], {
    cwd: env.cwd,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      TASKS_BASE: env.TASKS_BASE,
      NEXT_SCRIPT_LOG: '0', // quiet logging
    },
  });
}

describe('task-next.js auto-init in recordEvidence (regression for ea27b7f6)', () => {
  let tmp;
  let tasksBase;
  let worktree;
  let ticket = 'GH-99991';
  let phaseFile;

  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'task-next-autoinit-'));
    tasksBase = path.join(tmp, 'tasks');
    worktree = path.join(tmp, 'wt');
    fs.mkdirSync(path.join(tasksBase, ticket, 'task1'), { recursive: true });
    fs.mkdirSync(path.join(worktree, 'tmp', 'dbg'), { recursive: true });

    // Workspace marker (so requireTicketWorkspace passes).
    fs.writeFileSync(path.join(tasksBase, ticket, 'ticket.json'), JSON.stringify({ id: ticket }));

    // tasks.md with a real failing test command.
    fs.writeFileSync(
      path.join(tasksBase, ticket, 'tasks.md'),
      [
        '# Tasks',
        '',
        `_Ticket: ${ticket}_`,
        '',
        '## Task 1 — Multiply helper',
        '',
        '### Type',
        'backend',
        '',
        '### Test Command',
        '```bash',
        'node tmp/dbg/multiply.test.js',
        '```',
        '',
        '### Suggested Scope',
        '- `tmp/dbg/multiply.test.js`',
        '- `tmp/dbg/multiply.js`',
        '',
      ].join('\n')
    );

    // Test file:
    // - Contains a `test()` block so task-next.js's
    //   countTestBlocksInFiles() counts it (required for unit-only RED
    //   fallback when there are no @task:N gherkin scenarios).
    // - Exits non-zero deterministically when multiply.js is missing,
    //   exits zero when present — so task-next.js sees the correct
    //   phase signal. Bypasses `node --test`'s quirk of always
    //   returning 0 in some node versions even when subtests fail.
    fs.writeFileSync(
      path.join(worktree, 'tmp', 'dbg', 'multiply.test.js'),
      `const { test } = require('node:test');
let mod;
try { mod = require('./multiply'); } catch { mod = null; }
test('multiply doubles', () => {});
const got = mod && mod.multiply ? mod.multiply(3) : null;
if (got !== 6) {
  console.error('FAIL: expected 6, got', got);
  process.exit(1);
}
console.log('PASS');
process.exit(0);
`
    );

    // Make worktree a git repo so resolveWorktreeRoot works.
    spawnSync('git', ['init', '-q', worktree], { stdio: 'ignore' });

    phaseFile = path.join(tasksBase, ticket, 'task1', 'tdd-phase.json');
  });

  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('phase 1 — RED: auto-init creates tdd-phase.json and records red', () => {
    assert.equal(fs.existsSync(phaseFile), false, 'precondition: no state yet');

    const r = runTaskNext(ticket, 'task1', { cwd: worktree, TASKS_BASE: tasksBase });

    const combined = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. Output:\n${combined}`);
    assert.match(combined, /ADVANCED → green|RED accepted/, 'expected RED→GREEN advancement');
    assert.equal(fs.existsSync(phaseFile), true, 'auto-init should have created tdd-phase.json');

    const state = JSON.parse(fs.readFileSync(phaseFile, 'utf8'));
    assert.equal(
      state.currentPhase,
      'green',
      `expected currentPhase=green, got ${state.currentPhase}`
    );
    assert.ok(
      Array.isArray(state.cycles) && state.cycles.length >= 1,
      'cycles[] should have at least 1 entry'
    );
    assert.ok(state.cycles[0].red, 'cycle 1 should have red evidence');
  });

  it('phase 2 — GREEN: writing source advances to refactor and preserves cycle history', () => {
    fs.writeFileSync(
      path.join(worktree, 'tmp', 'dbg', 'multiply.js'),
      'module.exports = { multiply: (n) => n * 2 };\n'
    );

    const r = runTaskNext(ticket, 'task1', { cwd: worktree, TASKS_BASE: tasksBase });
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. Output:\n${combined}`);
    assert.match(combined, /ADVANCED → refactor/, 'expected GREEN→REFACTOR advancement');

    const state = JSON.parse(fs.readFileSync(phaseFile, 'utf8'));
    assert.equal(state.currentPhase, 'refactor');
    assert.ok(
      state.cycles[0].red,
      'red evidence must still be there (init must not have wiped it)'
    );
    assert.ok(state.cycles[0].green, 'green evidence must now exist');
  });

  it('phase 3 — REFACTOR: records refactor evidence; cycle complete', () => {
    const r = runTaskNext(ticket, 'task1', { cwd: worktree, TASKS_BASE: tasksBase });
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.equal(r.status, 0, `expected exit 0, got ${r.status}. Output:\n${combined}`);

    const state = JSON.parse(fs.readFileSync(phaseFile, 'utf8'));
    assert.ok(state.cycles[0].red, 'red evidence preserved');
    assert.ok(state.cycles[0].green, 'green evidence preserved');
    assert.ok(state.cycles[0].refactor, 'refactor evidence recorded');
  });
});
