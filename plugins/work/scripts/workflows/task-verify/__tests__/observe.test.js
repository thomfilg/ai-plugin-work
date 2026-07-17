'use strict';

/**
 * observe.js attributed-diff resolution unit tests (GH-769 Task 7).
 *
 * Live temp repos (mkdtemp + `git -C`, mirroring observe-live.test.js:26-60)
 * prove the three resolution rules:
 *   (a) serial repo, no Work-Task trailers → legacy base..HEAD diff, mode none
 *   (b) interleaved Work-Task:4 / Work-Task:1 → task 4's attributed files only
 *   (c) unresolvable base for the trailer read → legacy diff, supported false
 *   (d) taskNum omitted → no attribution key, behavior unchanged
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildObservations } = require('../observe');

// ---------------------------------------------------------------------------
// Temp-repo harness (mirrors observe-live.test.js)
// ---------------------------------------------------------------------------

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-attr-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const g = (args) =>
    execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  g(['init', '-q']);
  g(['config', 'user.email', 'test@example.com']);
  g(['config', 'user.name', 'Test']);
  const write = (rel, content) => {
    const full = path.join(repo, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const commit = (message, trailerValue) => {
    g(['add', '-A']);
    const args = ['commit', '-q', '--allow-empty', '-m', message];
    if (trailerValue !== undefined) args.push('--trailer', `Work-Task: ${trailerValue}`);
    g(args);
    return g(['rev-parse', 'HEAD']);
  };
  return { root, repo, g, write, commit };
}

const KIND = 'docs'; // profile that requires no test run — keeps the harness fast

// ---------------------------------------------------------------------------
// Rule (a): serial repo, no trailers → legacy diff, mode none
// ---------------------------------------------------------------------------

describe('buildObservations attributed resolution', () => {
  let serial;
  let serialBase;
  let wave;
  let waveBase;

  before(() => {
    serial = makeRepo();
    serial.write('base.txt', 'b\n');
    serialBase = serial.commit('base');
    serial.write('src/a.md', 'a\n');
    serial.commit('add a'); // no trailer
    serial.write('src/b.md', 'b\n');
    serial.commit('add b'); // no trailer

    wave = makeRepo();
    wave.write('base.txt', 'b\n');
    waveBase = wave.commit('base');
    // Interleaved 4,1,4,1
    wave.write('own-a.md', 'a\n');
    wave.commit('t4 first', '4');
    wave.write('foreign-1.md', 'f\n');
    wave.commit('t1 first', '1');
    wave.write('own-b.md', 'b\n');
    wave.commit('t4 second', 'task4');
    wave.write('foreign-2.md', 'f2\n');
    wave.commit('t1 second', 'task 1');
  });

  after(() => {
    fs.rmSync(serial.root, { recursive: true, force: true });
    fs.rmSync(wave.root, { recursive: true, force: true });
  });

  it('(a) serial repo with taskNum but no trailers keeps the legacy diff, mode none', () => {
    const obs = buildObservations({
      repoDir: serial.repo,
      baseRef: serialBase,
      scopeGlobs: ['src/**'],
      taskKind: KIND,
      taskNum: 4,
      baseWorktreeDir: path.join(serial.root, 'bwt'),
    });
    assert.deepEqual(obs.diff.filesChanged.sort(), ['src/a.md', 'src/b.md']);
    assert.equal(obs.attribution.supported, true);
    assert.equal(obs.attribution.mode, 'none');
    assert.deepEqual(obs.attribution.foreignTasks, []);
  });

  it('(b) interleaved wave resolves task 4 to its attributed files only', () => {
    const obs = buildObservations({
      repoDir: wave.repo,
      baseRef: waveBase,
      scopeGlobs: ['**'],
      taskKind: KIND,
      taskNum: 4,
      baseWorktreeDir: path.join(wave.root, 'bwt4'),
    });
    assert.deepEqual(obs.diff.filesChanged, ['own-a.md', 'own-b.md']);
    assert.equal(obs.diff.empty, false);
    assert.equal(obs.attribution.mode, 'trailer');
    assert.equal(obs.attribution.taskId, 4);
    assert.deepEqual(obs.attribution.foreignTasks, ['1']);
    // No sibling file leaks into task 4's observed diff.
    assert.ok(!obs.diff.filesChanged.includes('foreign-1.md'));
    assert.ok(!obs.diff.filesChanged.includes('foreign-2.md'));
  });

  it('(b2) the sibling task 1 resolves to ITS files only, disjoint from task 4', () => {
    const obs = buildObservations({
      repoDir: wave.repo,
      baseRef: waveBase,
      scopeGlobs: ['**'],
      taskKind: KIND,
      taskNum: 1,
      baseWorktreeDir: path.join(wave.root, 'bwt1'),
    });
    assert.deepEqual(obs.diff.filesChanged, ['foreign-1.md', 'foreign-2.md']);
    assert.deepEqual(obs.attribution.foreignTasks, ['4']);
  });

  it('(c) unresolvable base for the attribution read degrades without throwing', () => {
    // Collector fails on the bogus ref → supported:false; the observe path
    // stays fail-open (no throw, degraded attribution, empty legacy diff).
    const obs = buildObservations({
      repoDir: wave.repo,
      baseRef: 'no-such-ref',
      scopeGlobs: ['**'],
      taskKind: KIND,
      taskNum: 4,
      baseWorktreeDir: path.join(wave.root, 'bwtc'),
      headRef: waveBase,
    });
    assert.equal(obs.attribution.supported, false);
    assert.equal(obs.attribution.mode, 'none');
    assert.ok(Array.isArray(obs.diff.filesChanged));
  });

  it('(d) taskNum omitted → no attribution key, byte-for-byte legacy behavior', () => {
    const withNum = buildObservations({
      repoDir: serial.repo,
      baseRef: serialBase,
      scopeGlobs: ['src/**'],
      taskKind: KIND,
      baseWorktreeDir: path.join(serial.root, 'bwt-d'),
    });
    assert.equal('attribution' in withNum, false);
    assert.deepEqual(withNum.diff.filesChanged.sort(), ['src/a.md', 'src/b.md']);
  });
});
