/**
 * Integration tests for check-next.js SHA-gated terminal-state handling
 * (GH-307, echo-5213-3, echo-5808-C).
 *
 * Scenarios (subprocess against a real temp git repo, no manual state
 * surgery anywhere):
 *   - complete + same hash + passing reports → "still valid, nothing to do"
 *   - complete + same hash + NEEDS_WORK report → action needs_work (never
 *     "Already complete")
 *   - complete + hash drift (fix commit) → state auto-reset, fresh cycle
 *     starts, previousCycle audit trail recorded
 *
 * node:test + node:assert/strict; temp TASKS_BASE + git repo via mkdtempSync.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const scriptPath = path.join(__dirname, '..', 'check-next.js');

const TICKET = 'GH-307';

let base;
let repoDir;
let tasksBase;
let ticketDir;

function git(args, cwd = repoDir) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

/**
 * Mirror check-setup.js generateChangesHash semantics. The base ref resolves
 * to origin/main (BASE_BRANCH=main + origin remote present).
 */
function currentChangesHash() {
  const diff = git(['diff', 'origin/main...HEAD', '-w']);
  if (!diff) return 'no-changes';
  return crypto.createHash('sha256').update(diff).digest('hex').substring(0, 12);
}

function runCheckNext() {
  const stdout = execFileSync(process.execPath, [scriptPath, TICKET], {
    encoding: 'utf8',
    timeout: 90000,
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: repoDir,
    env: {
      ...process.env,
      TASKS_BASE: tasksBase,
      WORKTREES_BASE: base,
      BASE_BRANCH: 'main',
      // 2_start_env: resolve startDatabase() immediately instead of spawning
      // `make dev-local` and stalling on its 30s watchdog.
      DEV_COMMAND: 'echo "database system is ready"',
      // Tier-0 quality gate: `true` exits 0 instantly — keeps 4_run_tests fast
      SCRIPT_RUN_AFFECTED_UNIT: 'true',
      WEB_APPS: '',
    },
  });
  // check-next prints one pretty-printed JSON object
  return JSON.parse(stdout.slice(stdout.indexOf('{')));
}

function writeReport(file, status, hash) {
  fs.writeFileSync(
    path.join(ticketDir, file),
    [`**Changes Hash:** ${hash}`, '', `Status: ${status}`, '', '# Report'].join('\n')
  );
}

function writeCompleteState(overrides = {}) {
  fs.writeFileSync(
    path.join(ticketDir, '.check2-state.json'),
    JSON.stringify(
      {
        ticketId: TICKET,
        currentStep: '11_output',
        status: 'complete',
        dispatched: null,
        setupResult: { reportFolder: ticketDir, impactedApps: [], affectedFiles: {} },
        consensusIteration: 0,
        startTime: new Date().toISOString(),
        ...overrides,
      },
      null,
      2
    )
  );
}

function loadState() {
  return JSON.parse(fs.readFileSync(path.join(ticketDir, '.check2-state.json'), 'utf8'));
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'check-next-stale-'));
  repoDir = path.join(base, 'repo');
  tasksBase = path.join(base, 'tasks');
  ticketDir = path.join(tasksBase, TICKET);
  fs.mkdirSync(repoDir, { recursive: true });
  fs.mkdirSync(ticketDir, { recursive: true });

  git(['init', '-b', 'main']);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'base\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  // Self-remote so origin/main exists — getBaseBranch resolves BASE_BRANCH to
  // `origin/<name>`, and hash parity with check-setup depends on it.
  git(['remote', 'add', 'origin', repoDir]);
  git(['fetch', '-q', 'origin', 'main']);
  git(['checkout', '-b', 'feature']);
  fs.writeFileSync(path.join(repoDir, 'a.txt'), 'feature change\n');
  git(['add', '.']);
  git(['commit', '-m', 'feature']);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('check-next.js — SHA-gated terminal state', () => {
  it('reports "still valid, nothing to do" when hash unchanged and reports pass', () => {
    const hash = currentChangesHash();
    const head = git(['rev-parse', 'HEAD']);
    writeReport('tests.check.md', 'APPROVED', hash);
    writeReport('code-review.check.md', 'APPROVED', hash);
    writeReport('completion.check.md', 'COMPLETE', hash);
    writeCompleteState({ changesHash: hash, completedChangesHash: hash, completedHeadSha: head });

    const out = runCheckNext();
    assert.equal(out.action, 'complete');
    assert.match(out.summary, /still valid/i);
    // State untouched: still complete, no new cycle
    assert.equal(loadState().status, 'complete');
  });

  it('returns needs_work (never "Already complete") when a report is NEEDS_WORK at the current hash', () => {
    const hash = currentChangesHash();
    writeReport('tests.check.md', 'APPROVED', hash);
    writeReport('code-review.check.md', 'NEEDS_WORK', hash);
    writeReport('completion.check.md', 'COMPLETE', hash);
    writeCompleteState({ changesHash: hash });

    const out = runCheckNext();
    assert.equal(out.action, 'needs_work');
    assert.notEqual(out.summary, 'Already complete.');
    assert.match(out.reason, /code-review\.check\.md/);
    assert.equal(loadState().status, 'needs_work');
  });

  it('auto-starts a fresh cycle when the changes hash drifted (fix commit) — no --init needed', () => {
    const oldHash = currentChangesHash();
    writeReport('tests.check.md', 'APPROVED', oldHash);
    writeReport('code-review.check.md', 'NEEDS_WORK', oldHash);
    writeReport('completion.check.md', 'COMPLETE', oldHash);
    writeCompleteState({ changesHash: oldHash, completedChangesHash: oldHash });

    // Fix commit → new diff → new hash
    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'fixed change\n');
    git(['add', '.']);
    git(['commit', '-m', 'fix']);
    const newHash = currentChangesHash();
    assert.notEqual(newHash, oldHash);

    const out = runCheckNext();
    // Fresh cycle started and ran until the first delegation (phase-1 agents)
    assert.notEqual(out.summary, 'Already complete.');
    assert.equal(out.action, 'execute');

    const state = loadState();
    assert.equal(state.status, 'in_progress');
    assert.equal(state.changesHash, newHash);
    assert.ok(state.previousCycle, 'previousCycle audit trail must be recorded');
    assert.match(state.previousCycle.reason, /sha-drift/);
    assert.equal(state.previousCycle.changesHash, oldHash);

    // The stale NEEDS_WORK report was purged by the cycle-marker purge
    assert.equal(fs.existsSync(path.join(ticketDir, 'code-review.check.md')), false);
  });

  it('needs_work state also auto-resets on hash drift', () => {
    const oldHash = currentChangesHash();
    writeReport('code-review.check.md', 'NEEDS_WORK', oldHash);
    writeCompleteState({ status: 'needs_work', changesHash: oldHash });

    fs.writeFileSync(path.join(repoDir, 'a.txt'), 'another fix\n');
    git(['add', '.']);
    git(['commit', '-m', 'fix2']);

    const out = runCheckNext();
    assert.equal(out.action, 'execute');
    const state = loadState();
    assert.equal(state.status, 'in_progress');
    assert.match(state.previousCycle.reason, /sha-drift/);
  });
});
