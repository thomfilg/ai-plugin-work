// conductor-lock.js tests (GH-622) — per-namespace singleton guard so a second
// daemon in the same namespace is detected instead of double-driving agents.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const LOCK_LIB = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'conductor-lock.js');
const lock = require(LOCK_LIB);

function tmpLock() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lock-'));
  return path.join(dir, 'conductor.lock');
}

test('acquire on a free namespace succeeds and writes pid', () => {
  const file = tmpLock();
  const r = lock.acquire(file);
  assert.equal(r.ok, true);
  assert.equal(lock.readLock(file).pid, process.pid);
  lock.release(file);
  assert.equal(fs.existsSync(file), false);
});

test('second acquire is refused while a LIVE holder owns the lock', () => {
  const file = tmpLock();
  // Simulate another live conductor: our own pid is alive but differs from
  // process.pid only conceptually — write a definitely-live foreign pid (1,
  // init, always alive) so acquire sees a live "other".
  fs.writeFileSync(file, JSON.stringify({ pid: 1, startedAt: 0, host: 'x', ns: 'proj-a' }));
  const r = lock.acquire(file);
  assert.equal(r.ok, false);
  assert.equal(r.held.pid, 1);
});

test('MAESTRO_FORCE (force:true) takes over a live lock', () => {
  const file = tmpLock();
  fs.writeFileSync(file, JSON.stringify({ pid: 1, startedAt: 0, host: 'x', ns: 'proj-a' }));
  const r = lock.acquire(file, { force: true });
  assert.equal(r.ok, true);
  assert.equal(r.forced, true);
  assert.equal(lock.readLock(file).pid, process.pid);
});

test('a stale lock (dead pid) is reclaimed silently', () => {
  const file = tmpLock();
  // 2^31-ish pid that is virtually never alive.
  fs.writeFileSync(file, JSON.stringify({ pid: 2147480000, startedAt: 0, host: 'x' }));
  const r = lock.acquire(file);
  assert.equal(r.ok, true);
  assert.equal(r.forced, false);
  assert.equal(lock.readLock(file).pid, process.pid);
});

test('release only removes a lock we still own', () => {
  const file = tmpLock();
  lock.acquire(file);
  // Someone else stomped the lock after us.
  fs.writeFileSync(file, JSON.stringify({ pid: 1, startedAt: 0, host: 'x' }));
  lock.release(file);
  assert.equal(fs.existsSync(file), true, 'must not delete a foreign-owned lock');
});

test('re-acquire by the same pid is idempotent (ok, not refused)', () => {
  const file = tmpLock();
  lock.acquire(file);
  const r = lock.acquire(file);
  assert.equal(r.ok, true);
  lock.release(file);
});

test('acquire uses atomic create-exclusive (no read-check-write TOCTOU window)', () => {
  // GH-622 review: the first acquire must atomically create the file; a second
  // caller racing an already-present LIVE holder must see EEXIST and refuse,
  // never read-then-overwrite. We assert the post-condition: with a live holder
  // already present, acquire refuses rather than clobbering.
  const file = tmpLock();
  fs.writeFileSync(file, JSON.stringify({ pid: 1, startedAt: 0, host: 'x' }));
  const before = fs.readFileSync(file, 'utf8');
  const r = lock.acquire(file);
  assert.equal(r.ok, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'must not overwrite a live holder');
});

test('an unreadable/empty lock file is not stolen unless forced', () => {
  const file = tmpLock();
  fs.writeFileSync(file, ''); // present but unparseable (e.g. a creator mid-write)
  const refused = lock.acquire(file);
  assert.equal(refused.ok, false, 'must refuse a present-but-unreadable lock');
  // Forced takeover reclaims it.
  const forcedTake = lock.acquire(file, { force: true });
  assert.equal(forcedTake.ok, true);
  assert.equal(lock.readLock(file).pid, process.pid);
  lock.release(file);
});
