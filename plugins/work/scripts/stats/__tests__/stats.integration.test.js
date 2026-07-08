/**
 * Integration tests for the `/stats` backing script (GH-317 / Task 4).
 *
 * These tests spawn `stats.js` as a child process (the established hook-test
 * pattern in this repo) against temp TASKS_BASE / WORKTREES_BASE fixtures and
 * assert on stdout + exit code only. They never reach into the module
 * internals, so the implementation is free to refactor.
 *
 * Tagged @task:4. Covers gherkin scenarios:
 *   - /stats reports per-ticket progress from work state            (4.1)
 *   - /stats reports run duration and retry/loop count              (4.2, 4.3)
 *   - /stats reports git metrics for the ticket branch              (4.4)
 *   - /stats all aggregates every ticket dir into a compact table   (4.5)
 *   - /stats degrades gracefully when GH-311 token totals are absent (4.5)
 *   - error handling: unknown ticket / corrupt JSON                 (4.6)
 *
 * Run with:
 *   node --test scripts/stats/__tests__/stats.integration.test.js
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const STATS_JS = path.join(__dirname, '..', 'stats.js');
const REPO_NAME = 'demo-repo';

let tmpRoot;
let tasksBase;
let worktreesBase;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gh317-stats-'));
  worktreesBase = path.join(tmpRoot, 'worktrees');
  tasksBase = path.join(worktreesBase, 'tasks');
  fs.mkdirSync(tasksBase, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/**
 * Strip Node's module-loader crash trace from captured output so a not-yet-
 * implemented `stats.js` surfaces as a clean behavior failure (empty output,
 * non-zero exit) rather than leaking a "Cannot find module" stack into the
 * test-runner output. The assertions below still fail on the missing behavior.
 */
function sanitize(text) {
  if (!text) return '';
  if (/Cannot find module|MODULE_NOT_FOUND/.test(text)) return '';
  return text;
}

/** Spawn stats.js with the temp config in env; return { status, stdout, stderr }. */
function runStats(args, extraEnv = {}) {
  const res = spawnSync(process.execPath, [STATS_JS, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TASKS_BASE: tasksBase,
      WORKTREES_BASE: worktreesBase,
      REPO_NAME,
      ...extraEnv,
    },
  });
  return { ...res, stdout: sanitize(res.stdout), stderr: sanitize(res.stderr) };
}

/** Build the 19-step status map: steps before `currentStep` completed, rest pending. */
function buildStepStatus(allSteps, currentName) {
  const idx = allSteps.indexOf(currentName);
  const stepStatus = {};
  allSteps.forEach((step, i) => {
    stepStatus[step] = i < idx ? 'completed' : 'pending';
  });
  return stepStatus;
}

/** Write a `.work-state.json` for `ticket` under tasksBase and return its dir. */
function writeState(ticket, state) {
  const dir = path.join(tasksBase, ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.work-state.json'), JSON.stringify(state, null, 2));
  return dir;
}

const { ALL_STEPS } = require('../../workflows/work/step-registry');

/** A valid in-progress state at the implement step (no token fields). */
function implementState(ticket, overrides = {}) {
  return {
    ticketId: ticket,
    currentStep: ALL_STEPS.indexOf('implement') + 1, // 1-indexed
    status: 'in_progress',
    stepStatus: buildStepStatus(ALL_STEPS, 'implement'),
    checkProgress: {},
    errors: [],
    startTime: '2026-06-22T05:00:00.000Z',
    lastUpdate: '2026-06-22T06:30:00.000Z', // 1h30m later
    ...overrides,
  };
}

describe('stats.js — per-ticket step position (4.1, R1)', () => {
  it('reports the current step name and its position out of the total step count', () => {
    writeState('GH-100', implementState('GH-100'));
    const res = runStats(['GH-100']);
    assert.equal(res.status, 0, `expected exit 0, stderr: ${res.stderr}`);
    assert.match(res.stdout, /implement/, 'output must name the current step');
    // implement is the 9th of 19 steps.
    assert.match(
      res.stdout,
      new RegExp(`9\\s*/\\s*${ALL_STEPS.length}`),
      'output must show step position as 9/<total>'
    );
  });

  it('reports completed-vs-remaining step counts derived from ALL_STEPS', () => {
    writeState('GH-100', implementState('GH-100'));
    const res = runStats(['GH-100']);
    assert.equal(res.status, 0);
    // 8 steps completed before implement, 11 remaining (implement + 10 after).
    assert.match(res.stdout, /8/, 'output must show 8 completed steps');
    assert.match(res.stdout, /11/, 'output must show 11 remaining steps');
  });
});

describe('stats.js — run duration and per-step n/a (4.2, R2)', () => {
  it('shows the whole-run duration computed from startTime to lastUpdate', () => {
    writeState('GH-100', implementState('GH-100'));
    const res = runStats(['GH-100']);
    assert.equal(res.status, 0);
    // 1h30m between startTime and lastUpdate.
    assert.match(
      res.stdout,
      /1h\s*30m|1h30m|90m|01:30/,
      'output must show the run duration derived from startTime->lastUpdate'
    );
  });

  it('renders the per-step duration breakdown as n/a', () => {
    writeState('GH-100', implementState('GH-100'));
    const res = runStats(['GH-100']);
    assert.equal(res.status, 0);
    assert.match(res.stdout, /per-step[\s\S]*n\/a/i, 'per-step duration breakdown must render n/a');
  });
});

describe('stats.js — retry/loop count (4.3, R3)', () => {
  it('reports a retry count of 2 labeled as the check-to-implement loop', () => {
    // checkProgress encodes two check->implement re-entries.
    const state = implementState('GH-100', {
      checkProgress: { implement: 2 },
    });
    writeState('GH-100', state);
    const res = runStats(['GH-100']);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /Retries:\s*2/i, 'output must show "Retries: 2"');
    assert.match(
      res.stdout,
      /check[\s\S]*implement/i,
      'retry line must be labeled as the check->implement loop'
    );
  });
});

describe('stats.js — git metrics vs base (4.4, R4)', () => {
  it('shows commit count and lines added/removed/files changed versus base', () => {
    // Build a real git worktree at WORKTREES_BASE/REPO_NAME-GH-100 with
    // commits ahead of the base branch.
    const worktree = path.join(worktreesBase, `${REPO_NAME}-GH-100`);
    fs.mkdirSync(worktree, { recursive: true });
    const git = (cmd) =>
      execFileSync('git', cmd, {
        cwd: worktree,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'T',
          GIT_AUTHOR_EMAIL: 't@e.x',
          GIT_COMMITTER_NAME: 'T',
          GIT_COMMITTER_EMAIL: 't@e.x',
        },
      });
    git(['init', '-q', '-b', 'main']);
    fs.writeFileSync(path.join(worktree, 'base.txt'), 'one\ntwo\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'base commit']);
    // Create the ticket branch and add two commits ahead of main.
    git(['checkout', '-q', '-b', 'GH-100']);
    fs.writeFileSync(path.join(worktree, 'feature.txt'), 'a\nb\nc\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'feat 1']);
    fs.appendFileSync(path.join(worktree, 'feature.txt'), 'd\n');
    git(['add', '.']);
    git(['commit', '-q', '-m', 'feat 2']);

    writeState('GH-100', implementState('GH-100'));
    const res = runStats(['GH-100'], { BASE_BRANCH: 'main' });
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    // 2 commits ahead of main.
    assert.match(res.stdout, /2/, 'output must show a commit count of 2');
    // 4 lines added (3 in feat 1 + 1 in feat 2), 0 removed, 1 file changed.
    assert.match(res.stdout, /\+\s*4|4\s*added|added.*4/i, 'must show 4 lines added');
    assert.match(res.stdout, /1\s*file|files.*1|file.*1/i, 'must show 1 file changed');
  });

  it('renders git metrics as n/a when the worktree is missing', () => {
    writeState('GH-100', implementState('GH-100'));
    const res = runStats(['GH-100']);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /n\/a/i, 'missing worktree git metrics must render n/a');
  });
});

describe('stats.js all — aggregation table (4.5, R5)', () => {
  it('emits a compact table with one row per ticket dir', () => {
    writeState('GH-100', implementState('GH-100'));
    writeState('GH-200', implementState('GH-200'));
    writeState('GH-300', implementState('GH-300'));
    const res = runStats(['all']);
    assert.equal(res.status, 0, `stderr: ${res.stderr}`);
    assert.match(res.stdout, /GH-100/, 'table must include GH-100 row');
    assert.match(res.stdout, /GH-200/, 'table must include GH-200 row');
    assert.match(res.stdout, /GH-300/, 'table must include GH-300 row');
    // One row per ticket: each ticket id appears exactly once.
    const rows = res.stdout.split('\n').filter((l) => /GH-\d00/.test(l));
    assert.equal(rows.length, 3, 'exactly one row per ticket dir');
  });

  it('keeps aggregating and exits 0 when one ticket dir has corrupt state', () => {
    writeState('GH-100', implementState('GH-100'));
    // A second ticket dir with unreadable JSON must not abort the whole table.
    const badDir = path.join(tasksBase, 'GH-200');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, '.work-state.json'), '{ not json at all');
    const res = runStats(['all']);
    assert.equal(res.status, 0, `aggregation must not fail on one bad dir, stderr: ${res.stderr}`);
    assert.match(res.stdout, /GH-100/, 'valid ticket row must still render');
    // The corrupt ticket is surfaced rather than silently dropped.
    assert.match(res.stdout, /GH-200/, 'corrupt ticket must still appear in the table');
  });
});

describe('stats.js — token degradation (4.5, R13)', () => {
  it('renders tokens as n/a noting it requires GH-311 and does not fail', () => {
    writeState('GH-100', implementState('GH-100')); // no token fields
    const res = runStats(['GH-100']);
    assert.equal(res.status, 0, 'command must not fail when token totals are absent');
    assert.match(
      res.stdout,
      /tokens:\s*n\/a\s*\(requires GH-311\)/i,
      'must render "tokens: n/a (requires GH-311)"'
    );
  });
});

describe('stats.js — error handling (4.6, R17)', () => {
  it('unknown ticket -> single [FAIL] no .work-state.json line with non-zero exit', () => {
    const res = runStats(['GH-999']); // never written
    assert.notEqual(res.status, 0, 'unknown ticket must exit non-zero');
    assert.match(
      res.stdout + res.stderr,
      /\[FAIL\]\s*no \.work-state\.json for GH-999/i,
      'must emit "[FAIL] no .work-state.json for GH-999"'
    );
  });

  it('corrupt JSON -> [FAIL] unreadable state without throwing', () => {
    const dir = path.join(tasksBase, 'GH-100');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.work-state.json'), '{ this is not json');
    const res = runStats(['GH-100']);
    // Never throws: a clean process result with no uncaught-exception trace.
    assert.ok(res.error === undefined || res.error === null, 'must not throw');
    assert.doesNotMatch(
      res.stderr || '',
      /at Object\.<anonymous>|throw new Error|SyntaxError/,
      'must not surface an uncaught stack trace'
    );
    assert.match(
      res.stdout + res.stderr,
      /\[FAIL\]\s*unreadable state/i,
      'must emit "[FAIL] unreadable state"'
    );
  });
});
