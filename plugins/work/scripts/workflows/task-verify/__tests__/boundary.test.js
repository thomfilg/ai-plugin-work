'use strict';

/**
 * boundary.js taskNum-threading unit tests (GH-769 Task 9).
 *
 * observeBoundary must thread its existing taskNum into buildObservations so a
 * live boundary resolves the diff from THIS task's attributed commits. Driven
 * through the real entrypoint against a temp repo + synthetic tasks dir.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { observeBoundary } = require('../boundary');

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
  const args = ['commit', '-q', '--allow-empty', '-m', message];
  if (trailerValue !== undefined) args.push('--trailer', `Work-Task: ${trailerValue}`);
  git(args);
  return git(['rev-parse', 'HEAD']);
}

const TASKS_MD = [
  '# Tasks',
  '',
  '## Task 1 — module A',
  '',
  '### Type',
  'docs',
  '',
  '### Files in scope',
  '- `a.md`',
  '',
  '## Task 2 — module B',
  '',
  '### Type',
  'docs',
  '',
  '### Files in scope',
  '- `b.md`',
  '',
].join('\n');

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-attr-'));
  REPO = path.join(ROOT, 'repo');
  TASKS = path.join(ROOT, 'tasks');
  fs.mkdirSync(REPO);
  fs.mkdirSync(TASKS);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);

  write('base.md', 'base\n');
  baseSha = commit('base');
  fs.writeFileSync(path.join(TASKS, 'tasks.md'), TASKS_MD);
  fs.writeFileSync(path.join(TASKS, '.last-commit-sha'), baseSha);

  // Interleaved Work-Task:1 / Work-Task:2 (order 1,2,1,2).
  write('a.md', 'a1\n');
  commit('t1 first', '1');
  write('b.md', 'b1\n');
  commit('t2 first', '2');
  write('a.md', 'a2\n');
  commit('t1 second', '1');
  write('b.md', 'b2\n');
  commit('t2 second', '2');
});

after(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('observeBoundary taskNum threading (GH-769)', () => {
  it('resolves task 2 to its attributed files with foreignTasks naming task 1', () => {
    const out = observeBoundary({
      repoDir: REPO,
      tasksDir: TASKS,
      taskNum: 2,
      taskType: 'docs',
      baseWorktreeDir: path.join(ROOT, 'bwt2'),
    });
    assert.ok(!out.error, `unexpected error: ${out.error}`);
    assert.equal(out.observations.attribution.taskId, 2);
    assert.deepEqual(out.observations.attribution.foreignTasks, ['1']);
    assert.deepEqual(out.observations.diff.filesChanged, ['b.md']);
    assert.ok(!out.observations.diff.filesChanged.includes('a.md'));
  });

  it('resolves task 1 to its attributed files, disjoint from task 2', () => {
    const out = observeBoundary({
      repoDir: REPO,
      tasksDir: TASKS,
      taskNum: 1,
      taskType: 'docs',
      baseWorktreeDir: path.join(ROOT, 'bwt1'),
    });
    assert.deepEqual(out.observations.diff.filesChanged, ['a.md']);
    assert.deepEqual(out.observations.attribution.foreignTasks, ['2']);
  });

  it('a serial repo (no trailers) keeps the legacy diff through the same entrypoint', () => {
    const sRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-serial-'));
    const sRepo = path.join(sRoot, 'repo');
    const sTasks = path.join(sRoot, 'tasks');
    fs.mkdirSync(sRepo);
    fs.mkdirSync(sTasks);
    const sg = (args) =>
      execFileSync('git', ['-C', sRepo, ...args], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    sg(['init', '-q']);
    sg(['config', 'user.email', 'test@example.com']);
    sg(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(sRepo, 'base.md'), 'base\n');
    sg(['add', '-A']);
    sg(['commit', '-qm', 'base']);
    const sBase = sg(['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(sTasks, 'tasks.md'), TASKS_MD);
    fs.writeFileSync(path.join(sTasks, '.last-commit-sha'), sBase);
    fs.writeFileSync(path.join(sRepo, 'a.md'), 'a\n');
    fs.writeFileSync(path.join(sRepo, 'b.md'), 'b\n');
    sg(['add', '-A']);
    sg(['commit', '-qm', 'no trailer work']);

    const out = observeBoundary({
      repoDir: sRepo,
      tasksDir: sTasks,
      taskNum: 1,
      taskType: 'docs',
      baseWorktreeDir: path.join(sRoot, 'bwt'),
    });
    assert.equal(out.observations.attribution.mode, 'none');
    assert.deepEqual(out.observations.diff.filesChanged.sort(), ['a.md', 'b.md']);
    fs.rmSync(sRoot, { recursive: true, force: true });
  });
});
