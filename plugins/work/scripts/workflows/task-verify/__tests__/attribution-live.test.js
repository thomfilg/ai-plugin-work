'use strict';

/**
 * Two-task wave integration test (GH-769 Task 10).
 *
 * A live temp repo where two tasks commit interleaved (order 1,2,1,2) into one
 * shared worktree, each stamping its own `Work-Task` trailer. Driven through
 * the REAL entrypoints (buildObservations + observeBoundary + evaluate), this
 * proves the end-to-end attribution contract shipped by Tasks 1/3/7/9:
 *   - each task's resolved diff is disjoint and contains only its own files
 *   - each attribution.foreignTasks names exactly the sibling
 *   - evaluate yields UNVERIFIED with ['cross-task-attribution'] (clean own
 *     work + the mechanism-failure wave flag, never a block)
 *
 * No production file is modified here — this suite pins already-shipped
 * behavior.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildObservations } = require('../observe');
const { observeBoundary } = require('../boundary');
const { evaluate } = require('../verdict-engine');
const { VERDICTS } = require('../../lib/outcome-verdicts');

let ROOT;
let REPO;
let TASKS;
let baseSha;

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

function commit(message, trailerValue) {
  git(['add', '-A']);
  git(['commit', '-q', '-m', message, '--trailer', `Work-Task: ${trailerValue}`]);
  return git(['rev-parse', 'HEAD']);
}

// docs kind keeps the harness fast (no derived-test execution); the diff-only
// attribution mechanics are identical across kinds.
const TASKS_MD = [
  '# Tasks',
  '',
  '## Task 1 — module A',
  '### Type',
  'docs',
  '### Files in scope',
  '- src/a.js',
  '- src/__tests__/a.test.js',
  '',
  '## Task 2 — module B',
  '### Type',
  'docs',
  '### Files in scope',
  '- src/b.js',
  '- src/__tests__/b.test.js',
  '',
].join('\n');

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'attribution-live-'));
  REPO = path.join(ROOT, 'repo');
  TASKS = path.join(ROOT, 'tasks');
  fs.mkdirSync(REPO);
  fs.mkdirSync(TASKS);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);

  // Base commit: buggy modules A and B + a node --test package.
  write('package.json', JSON.stringify({ name: 't', scripts: { test: 'node --test' } }));
  write('src/a.js', 'module.exports = { a: () => 0 };\n');
  write('src/b.js', 'module.exports = { b: () => 0 };\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'base: buggy A and B']);
  baseSha = git(['rev-parse', 'HEAD']);

  fs.writeFileSync(path.join(TASKS, 'tasks.md'), TASKS_MD);
  fs.writeFileSync(path.join(TASKS, '.last-commit-sha'), baseSha);

  // Interleaved wave: task 1 fixes A + authors a.test.js; task 2 fixes B +
  // authors b.test.js — order 1,2,1,2 to force range interleaving.
  write('src/a.js', 'module.exports = { a: () => 1 };\n');
  commit('t1: fix a', '1');
  write('src/b.js', 'module.exports = { b: () => 1 };\n');
  commit('t2: fix b', '2');
  write('src/__tests__/a.test.js', "require('node:test');\n");
  commit('t1: author a.test', '1');
  write('src/__tests__/b.test.js', "require('node:test');\n");
  commit('t2: author b.test', '2');
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function observeTask(taskNum) {
  return buildObservations({
    repoDir: REPO,
    baseRef: baseSha,
    scopeGlobs: ['src/**'],
    taskKind: 'docs',
    taskNum,
    baseWorktreeDir: path.join(ROOT, `bwt-${taskNum}`),
  });
}

describe('two-task wave — disjoint correctly-attributed boundaries (GH-769)', () => {
  it('the shared range contains both tasks interleaved (harness sanity)', () => {
    const log = git(['log', '--format=%s', `${baseSha}..HEAD`]);
    assert.match(log, /t1: /);
    assert.match(log, /t2: /);
    assert.equal(log.split('\n').length, 4);
  });

  it('task 1 resolves to ITS files only', () => {
    const obs = observeTask(1);
    assert.deepEqual(obs.diff.filesChanged, ['src/__tests__/a.test.js', 'src/a.js']);
    assert.equal(obs.attribution.taskId, 1);
  });

  it('task 2 resolves to ITS files only', () => {
    const obs = observeTask(2);
    assert.deepEqual(obs.diff.filesChanged, ['src/__tests__/b.test.js', 'src/b.js']);
    assert.equal(obs.attribution.taskId, 2);
  });

  it('the two resolved diffs are disjoint — zero cross-task files', () => {
    const one = new Set(observeTask(1).diff.filesChanged);
    const two = new Set(observeTask(2).diff.filesChanged);
    for (const f of one) assert.ok(!two.has(f), `${f} leaked into both diffs`);
    assert.ok(![...one].some((f) => f.includes('/b')));
    assert.ok(![...two].some((f) => f.includes('/a')));
  });

  it('each attribution.foreignTasks names exactly the sibling', () => {
    assert.deepEqual(observeTask(1).attribution.foreignTasks, ['2']);
    assert.deepEqual(observeTask(2).attribution.foreignTasks, ['1']);
  });

  it('evaluate yields UNVERIFIED + [cross-task-attribution] for each task', () => {
    for (const num of [1, 2]) {
      const result = evaluate(observeTask(num), 'docs');
      assert.equal(result.verdict, VERDICTS.unverified, result.reasons.join(' | '));
      assert.deepEqual(result.flags, ['cross-task-attribution']);
      assert.equal(result.exit, null, 'attribution never blocks');
      assert.ok(
        result.reasons.some((r) => r.includes(String(num))),
        'reason names the expected task id'
      );
    }
  });

  it('the real observeBoundary entrypoint carries the attributed diff and flag', () => {
    const out = observeBoundary({
      repoDir: REPO,
      tasksDir: TASKS,
      taskNum: 2,
      taskType: 'docs',
      baseWorktreeDir: path.join(ROOT, 'bwt-boundary'),
    });
    assert.ok(!out.error, out.error);
    assert.deepEqual(out.observations.diff.filesChanged, ['src/__tests__/b.test.js', 'src/b.js']);
    assert.deepEqual(out.observations.attribution.foreignTasks, ['1']);
    assert.equal(out.result.verdict, VERDICTS.unverified);
    assert.deepEqual(out.result.flags, ['cross-task-attribution']);
  });
});
