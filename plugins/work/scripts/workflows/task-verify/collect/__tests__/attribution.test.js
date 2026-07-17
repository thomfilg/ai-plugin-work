'use strict';

/**
 * Attribution collector unit tests (GH-769 Task 1).
 * Covers trailer-value parsing, commit partitioning, attributed file union,
 * and the fail-open `resolveAttribution` entrypoint against a live temp repo.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  WORK_TASK_TRAILER,
  parseWorkTaskValue,
  commitsInRange,
  partitionForTask,
  changedFilesForCommits,
  resolveAttribution,
} = require('../attribution');

// ---------------------------------------------------------------------------
// Temp-repo helpers (mirrors observe-live.test.js setup)
// ---------------------------------------------------------------------------

let ROOT;
let REPO;
let baseSha;
/** sha per commit label for range assertions */
const SHAS = {};

function git(args) {
  return execFileSync('git', ['-C', REPO, ...args], {
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(rel, content) {
  const full = path.join(REPO, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

/** Commit all pending changes; optional Work-Task trailer value. */
function commit(message, trailerValue) {
  git(['add', '-A']);
  const args = ['commit', '-q', '--allow-empty', '-m', message];
  if (trailerValue !== undefined) {
    args.push('--trailer', `${WORK_TASK_TRAILER}: ${trailerValue}`);
  }
  git(args);
  return git(['rev-parse', 'HEAD']);
}

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'attribution-test-'));
  REPO = path.join(ROOT, 'repo');
  fs.mkdirSync(REPO);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);

  write('base.txt', 'base\n');
  baseSha = commit('base commit');

  // Interleaved attributed + unattributed commits.
  write('own-a.txt', 'a\n');
  SHAS.ownA = commit('task4 first', '4');

  write('foreign-1.txt', 'f\n');
  SHAS.foreign1 = commit('task1 work', 'task 1');

  write('own-b.txt', 'b\n');
  write('own-a.txt', 'a2\n');
  SHAS.ownB = commit('task4 second', 'task4');

  write('junk.txt', 'j\n');
  SHAS.junk = commit('hostile trailer', '../../etc/passwd');

  write('plain.txt', 'p\n');
  SHAS.plain = commit('no trailer at all');
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1.1 parseWorkTaskValue
// ---------------------------------------------------------------------------

describe('parseWorkTaskValue', () => {
  it('accepts canonical and tolerated forms', () => {
    assert.equal(parseWorkTaskValue('4'), 4);
    assert.equal(parseWorkTaskValue('task4'), 4);
    assert.equal(parseWorkTaskValue('task 4'), 4);
    assert.equal(parseWorkTaskValue('TASK 4'), 4);
    assert.equal(parseWorkTaskValue('  12  '), 12);
    assert.equal(parseWorkTaskValue('0042'), 42);
  });

  it('rejects hostile or malformed values as null', () => {
    assert.equal(parseWorkTaskValue(''), null);
    assert.equal(parseWorkTaskValue('4x'), null);
    assert.equal(parseWorkTaskValue('12345'), null); // five digits
    assert.equal(parseWorkTaskValue('../../etc/passwd'), null);
    assert.equal(parseWorkTaskValue('$(rm -rf /)'), null);
    assert.equal(parseWorkTaskValue('not-a-task'), null);
    assert.equal(parseWorkTaskValue('task'), null);
    assert.equal(parseWorkTaskValue(null), null);
    assert.equal(parseWorkTaskValue(undefined), null);
  });
});

// ---------------------------------------------------------------------------
// 1.1 WORK_TASK_TRAILER
// ---------------------------------------------------------------------------

describe('WORK_TASK_TRAILER', () => {
  it('is the literal trailer key', () => {
    assert.equal(WORK_TASK_TRAILER, 'Work-Task');
  });
});

// ---------------------------------------------------------------------------
// 1.1 partitionForTask
// ---------------------------------------------------------------------------

describe('partitionForTask', () => {
  it('keeps own shas in order, dedupes+sorts foreign ids, counts unattributed', () => {
    const commits = [
      { sha: 'a1', taskId: 4 },
      { sha: 'b2', taskId: 2 },
      { sha: 'c3', taskId: null },
      { sha: 'd4', taskId: 4 },
      { sha: 'e5', taskId: 10 },
      { sha: 'f6', taskId: 2 },
      { sha: 'g7', taskId: null },
    ];
    const out = partitionForTask(commits, 4);
    assert.deepEqual(out.own, ['a1', 'd4']);
    assert.deepEqual(out.foreignTasks, ['2', '10']);
    assert.equal(out.unattributedCount, 2);
  });

  it('handles an empty commit list', () => {
    const out = partitionForTask([], 4);
    assert.deepEqual(out.own, []);
    assert.deepEqual(out.foreignTasks, []);
    assert.equal(out.unattributedCount, 0);
  });
});

// ---------------------------------------------------------------------------
// 1.1 commitsInRange (live repo)
// ---------------------------------------------------------------------------

describe('commitsInRange', () => {
  it('lists commits oldest-first with their attributed task id', () => {
    const commits = commitsInRange(REPO, baseSha, 'HEAD');
    assert.deepEqual(
      commits.map((c) => c.sha),
      [SHAS.ownA, SHAS.foreign1, SHAS.ownB, SHAS.junk, SHAS.plain]
    );
    assert.deepEqual(
      commits.map((c) => c.taskId),
      [4, 1, 4, null, null]
    );
  });
});

// ---------------------------------------------------------------------------
// 1.2 changedFilesForCommits (live repo)
// ---------------------------------------------------------------------------

describe('changedFilesForCommits', () => {
  it('returns the sorted deduped union of files touched by the commits', () => {
    const files = changedFilesForCommits(REPO, [SHAS.ownA, SHAS.ownB]);
    assert.deepEqual(files, ['own-a.txt', 'own-b.txt']);
  });

  it('returns an empty array for an empty sha list', () => {
    assert.deepEqual(changedFilesForCommits(REPO, []), []);
  });

  it('merge commits contribute nothing', () => {
    // Build a side branch and merge it; the merge commit itself must not add
    // files to the union (diff-tree --no-commit-id -r on a merge is empty).
    git(['checkout', '-qb', 'side', baseSha]);
    write('side.txt', 's\n');
    const sideSha = commit('side work', '9');
    git(['checkout', '-q', '-']);
    git(['merge', '-q', '--no-ff', '-m', 'merge side', 'side']);
    const mergeSha = git(['rev-parse', 'HEAD']);
    assert.deepEqual(changedFilesForCommits(REPO, [mergeSha]), []);
    // side commit alone still reports its file
    assert.deepEqual(changedFilesForCommits(REPO, [sideSha]), ['side.txt']);
    // Reset back so later range assertions are unaffected.
    git(['reset', '-q', '--hard', SHAS.plain]);
    git(['branch', '-qD', 'side']);
  });
});

// ---------------------------------------------------------------------------
// 1.2 resolveAttribution (live repo + fail-open)
// ---------------------------------------------------------------------------

describe('resolveAttribution', () => {
  it('resolves a trailer range to this task attributed files only', () => {
    const res = resolveAttribution({
      repoDir: REPO,
      baseRef: baseSha,
      headRef: 'HEAD',
      taskNum: 4,
    });
    assert.equal(res.supported, true);
    assert.equal(res.mode, 'trailer');
    assert.equal(res.taskId, 4);
    assert.deepEqual(res.foreignTasks, ['1']);
    assert.equal(res.unattributedCount, 2);
    assert.deepEqual(res.attributedFiles, ['own-a.txt', 'own-b.txt']);
  });

  it('falls back to mode none for an empty range', () => {
    const empty = resolveAttribution({
      repoDir: REPO,
      baseRef: baseSha,
      headRef: baseSha,
      taskNum: 4,
    });
    assert.equal(empty.supported, true);
    assert.equal(empty.mode, 'none');
    assert.deepEqual(empty.foreignTasks, []);
    assert.equal(empty.unattributedCount, 0);
    assert.deepEqual(empty.attributedFiles, []);
  });

  it('resolves a single-own-commit range in trailer mode', () => {
    const res = resolveAttribution({
      repoDir: REPO,
      baseRef: baseSha,
      headRef: SHAS.ownA,
      taskNum: 4,
    });
    assert.equal(res.mode, 'trailer');
    assert.deepEqual(res.attributedFiles, ['own-a.txt']);
  });

  it('reports mode none when every commit is unattributed', () => {
    const res = resolveAttribution({
      repoDir: REPO,
      baseRef: SHAS.junk,
      headRef: SHAS.plain,
      taskNum: 4,
    });
    assert.equal(res.supported, true);
    assert.equal(res.mode, 'none');
    assert.equal(res.unattributedCount, 1);
    assert.deepEqual(res.attributedFiles, []);
  });

  it('never throws: bogus repoDir degrades to supported false', () => {
    const res = resolveAttribution({
      repoDir: path.join(ROOT, 'does-not-exist'),
      baseRef: 'main',
      headRef: 'HEAD',
      taskNum: 4,
    });
    assert.deepEqual(res, {
      supported: false,
      mode: 'none',
      taskId: null,
      foreignTasks: [],
      unattributedCount: 0,
      attributedFiles: [],
    });
  });

  it('never throws: unresolvable ref degrades to supported false', () => {
    const res = resolveAttribution({
      repoDir: REPO,
      baseRef: 'no-such-ref',
      headRef: 'HEAD',
      taskNum: 4,
    });
    assert.equal(res.supported, false);
    assert.equal(res.mode, 'none');
  });
});
