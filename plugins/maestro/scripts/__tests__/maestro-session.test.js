// maestro-session.js — orchestration session manifest CRUD + dep resolver.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function freshModule(sessionDir) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('maestro-session')) delete require.cache[k];
  }
  process.env.MAESTRO_SESSION_DIR = sessionDir;
  return require(path.resolve(__dirname, '..', 'maestro-session.js'));
}

test('init persists topic, slots, tasks; status starts pending', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-'));
  const m = freshModule(dir);
  const s = m.init('plug-bugs', 5, [
    { id: 'GH-1', priority: 1, deps: [] },
    { id: 'GH-2', priority: 2, deps: ['GH-1'] },
  ]);
  assert.equal(s.topic, 'plug-bugs');
  assert.equal(s.slots, 5);
  assert.equal(s.tasks.length, 2);
  assert.equal(s.tasks[0].status, 'pending');
  assert.equal(s.tasks[1].status, 'pending');
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'plug-bugs.json'), 'utf8'));
  assert.equal(onDisk.topic, 'plug-bugs');
});

test('init rejects task with unknown dep reference', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-bad-'));
  const m = freshModule(dir);
  assert.throws(
    () => m.init('bad', 1, [{ id: 'A', priority: 1, deps: ['UNKNOWN'] }]),
    /depends on unknown UNKNOWN/
  );
});

test('init rejects invalid topic / zero slots / empty tasks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-val-'));
  const m = freshModule(dir);
  assert.throws(() => m.init('bad topic', 1, [{ id: 'A', priority: 1 }]), /bad topic/);
  assert.throws(() => m.init('ok', 0, [{ id: 'A', priority: 1 }]), /slots must be/);
  assert.throws(() => m.init('ok', 1, []), /at least one task/);
});

test('update flips status and persists', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-upd-'));
  const m = freshModule(dir);
  m.init('topic', 3, [{ id: 'X', priority: 1, deps: [] }]);
  m.update('topic', 'X', 'in_progress');
  assert.equal(m.read('topic').tasks[0].status, 'in_progress');
  m.update('topic', 'X', 'done', 'merged in PR #42');
  const t = m.read('topic').tasks[0];
  assert.equal(t.status, 'done');
  assert.equal(t.note, 'merged in PR #42');
  assert.ok(t.updatedAt);
});

test('update rejects unknown status', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-bs-'));
  const m = freshModule(dir);
  m.init('t', 1, [{ id: 'X', priority: 1 }]);
  assert.throws(() => m.update('t', 'X', 'banana'), /bad status/);
});

test('nextEligible returns highest-priority pending task whose deps are done', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-next-'));
  const m = freshModule(dir);
  m.init('t', 2, [
    { id: 'A', priority: 1, deps: [] }, // top priority
    { id: 'B', priority: 2, deps: ['A'] }, // needs A
    { id: 'C', priority: 3, deps: [] }, // independent, lower priority
  ]);
  // A is eligible first (priority 1, no deps).
  assert.equal(m.nextEligible('t').id, 'A');
  m.update('t', 'A', 'done');
  // Now B is eligible (deps satisfied) and beats C on priority.
  assert.equal(m.nextEligible('t').id, 'B');
  m.update('t', 'B', 'in_progress');
  // B is in_progress (not pending) — C is the only pending eligible.
  assert.equal(m.nextEligible('t').id, 'C');
  m.update('t', 'B', 'done');
  m.update('t', 'C', 'done');
  // All done — nothing eligible.
  assert.equal(m.nextEligible('t'), null);
});

test('list returns all active sessions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-list-'));
  const m = freshModule(dir);
  m.init('a', 1, [{ id: 'X', priority: 1 }]);
  m.init('b', 2, [{ id: 'Y', priority: 1 }]);
  const all = m.list();
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((s) => s.topic).sort(), ['a', 'b']);
});

test('summarize emits the operator-facing one-liner', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-sum-'));
  const m = freshModule(dir);
  m.init('topic', 5, [
    { id: 'A', priority: 1 },
    { id: 'B', priority: 2 },
    { id: 'C', priority: 3 },
  ]);
  m.update('topic', 'A', 'done');
  m.update('topic', 'B', 'in_progress');
  const line = m.summarize(m.read('topic'));
  assert.match(line, /topic: slots=5/);
  assert.match(line, /1 in flight/);
  assert.match(line, /1\/3 done/);
  assert.match(line, /1 pending/);
});

test('clear removes the session file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-clr-'));
  const m = freshModule(dir);
  m.init('rm', 1, [{ id: 'X', priority: 1 }]);
  assert.ok(fs.existsSync(path.join(dir, 'rm.json')));
  assert.equal(m.clear('rm'), true);
  assert.equal(fs.existsSync(path.join(dir, 'rm.json')), false);
  assert.equal(m.clear('rm'), false);
});
