'use strict';

/**
 * Outcome-gate tests (GH-756): in WORK_TDD_MODE=outcome, task advance is
 * decided by the verifier verdict over a REAL repo boundary — VERIFIED and
 * UNVERIFIED advance (flags recorded on the work state), CONTRADICTED rides
 * the existing typed exits (retry guidance / planner hold), and verifier
 * mechanism failures advance with a flag instead of blocking.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runOutcomeGate, recordOutcomeFlags } = require('../outcome-gate');
const { VERDICTS } = require('../../lib/outcome-verdicts');

let ROOT;
let REPO;
let TASKS_DIR;
let baseSha;

function git(args) {
  return execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function write(rel, content) {
  const full = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'outcome-gate-test-'));
  REPO = path.join(ROOT, 'repo');
  TASKS_DIR = path.join(ROOT, 'tasks', 'TEST-OG-1');
  fs.mkdirSync(REPO, { recursive: true });
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  process.env.TASKS_BASE = path.join(ROOT, 'tasks');

  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  write('package.json', JSON.stringify({ name: 't', scripts: { test: 'node --test' } }));
  write('src/calc.js', 'module.exports = { mul: (a, b) => a + b };\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base: buggy mul']);
  baseSha = git(['rev-parse', 'HEAD']);

  // The real task: fix + test.
  write('src/calc.js', 'module.exports = { mul: (a, b) => a * b };\n');
  write(
    'src/__tests__/calc.test.js',
    [
      "const { test } = require('node:test');",
      "const assert = require('node:assert/strict');",
      "const { mul } = require('../calc.js');",
      "test('mul multiplies', () => { assert.equal(mul(3, 4), 12); });",
      '',
    ].join('\n')
  );
  git(['add', '-A']);
  git(['commit', '-qm', 'task 1: fix mul']);

  fs.writeFileSync(path.join(TASKS_DIR, '.last-commit-sha'), baseSha);
  fs.writeFileSync(
    path.join(TASKS_DIR, 'tasks.md'),
    [
      '## Task 1 — Fix mul',
      '### Type',
      'backend',
      '### Files in scope',
      '- src/**',
      '### Dependencies',
      'None',
      '',
    ].join('\n')
  );
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function makeHarness() {
  const ws = { tasksMeta: { tasks: [{ id: 'task_1', status: 'in_progress' }] } };
  const saved = [];
  const retries = [];
  return {
    ws,
    saved,
    retries,
    input: {
      safeName: 'TEST-OG-1',
      ws,
      tasksDir: TASKS_DIR,
      taskNum: 1,
      taskType: 'tdd-code',
      repoDir: REPO,
      saveWorkState: (name, state) => saved.push({ name, state }),
      recordRetry: (reason, extras) => retries.push({ reason, extras }),
    },
  };
}

beforeEach(() => {
  // Reap any per-test base worktree so runs stay independent.
  const wt = path.join(TASKS_DIR, `.task-verify-base-${path.basename(REPO)}`);
  try {
    execFileSync('git', ['-C', REPO, 'worktree', 'remove', '--force', wt], { stdio: 'pipe' });
  } catch {
    /* not created yet */
  }
});

describe('outcome-gate (GH-756)', () => {
  it('VERIFIED real work advances with no flags and an allow audit row', () => {
    const h = makeHarness();
    const outcome = runOutcomeGate(h.input);
    assert.equal(outcome.advance, true);
    assert.equal(outcome.verdict, VERDICTS.verified);
    assert.deepEqual(outcome.flags, []);
    assert.equal(h.retries.length, 0);
    assert.deepEqual(h.ws.outcomeFlags, [], 'clean verdict leaves no flag entry');

    const rows = JSON.parse(fs.readFileSync(path.join(TASKS_DIR, '.work-actions.json'), 'utf8'));
    const verifyRows = rows.filter((r) => r.action === 'task-verify');
    assert.ok(verifyRows.length >= 1);
    assert.equal(verifyRows.at(-1).allow, true);
    assert.equal(verifyRows.at(-1).meta.verdict, VERDICTS.verified);
  });

  it('CONTRADICTED (empty boundary) blocks with retry guidance via recordRetry', () => {
    const h = makeHarness();
    fs.writeFileSync(path.join(TASKS_DIR, '.last-commit-sha'), git(['rev-parse', 'HEAD']));
    const outcome = runOutcomeGate(h.input);
    fs.writeFileSync(path.join(TASKS_DIR, '.last-commit-sha'), baseSha); // restore

    assert.equal(outcome.blocked, 'retry');
    assert.equal(h.retries.length, 1);
    assert.match(h.retries[0].reason, /CONTRADICTED/);
    assert.match(h.retries[0].reason, /I1/);
    assert.deepEqual(h.retries[0].extras, {}, 'retry exit does not park a planner hold');
  });

  it('reopen-artifact exit parks the planner hold via recordRetry extras', () => {
    const h = makeHarness();
    const fakeBoundary = {
      observations: { derivedTests: { files: [], runner: 'node-test' } },
      result: {
        verdict: VERDICTS.contradicted,
        violatedInvariants: ['I2'],
        flags: [],
        exit: 'reopen-artifact',
        reasons: ['I2: promised deliverables missing: docs/spec-entry.md'],
      },
    };
    const outcome = runOutcomeGate(h.input, { observe: () => fakeBoundary });
    assert.equal(outcome.blocked, 'reopen-artifact');
    assert.equal(h.retries[0].extras.defectKind, 'outcome-contradiction');
  });

  it('UNVERIFIED advances and records unresolved flags on the work state', () => {
    const h = makeHarness();
    const fakeBoundary = {
      observations: { derivedTests: { files: [], runner: 'none' } },
      result: {
        verdict: VERDICTS.unverified,
        violatedInvariants: [],
        flags: ['no-structured-reporter'],
        exit: null,
        reasons: [],
      },
    };
    const outcome = runOutcomeGate(h.input, { observe: () => fakeBoundary });
    assert.equal(outcome.advance, true);
    assert.deepEqual(
      h.ws.outcomeFlags.map((e) => e.task),
      [1]
    );
    assert.deepEqual(h.ws.outcomeFlags[0].flags, ['no-structured-reporter']);
    assert.ok(h.saved.length >= 1, 'flag entry persisted');
  });

  it('a re-verify that comes back clean resolves the task flag entry', () => {
    const ws = {
      outcomeFlags: [
        { task: 1, flags: ['tautology'] },
        { task: 2, flags: ['x'] },
      ],
    };
    recordOutcomeFlags(ws, 1, VERDICTS.verified, []);
    assert.deepEqual(
      ws.outcomeFlags.map((e) => e.task),
      [2],
      'clean pass clears task 1'
    );
  });

  it('verifier mechanism failure advances with a flag, never blocks', () => {
    const h = makeHarness();
    h.input.repoDir = path.join(ROOT, 'not-a-repo');
    const outcome = runOutcomeGate(h.input);
    assert.equal(outcome.advance, true);
    assert.equal(outcome.verdict, VERDICTS.unverified);
    assert.deepEqual(outcome.flags, ['runner-unknown']);
    assert.equal(h.retries.length, 0);
  });
});
