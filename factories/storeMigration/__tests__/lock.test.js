'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createFileLock, readLock } = require('../lock');

let base;
const target = () => path.join(base, 'thing');

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-'));
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('config validation', () => {
  it('rejects non-function hooks and a non-positive staleAfterMs', () => {
    assert.throws(() => createFileLock({ lockPathFor: 'x' }), /"lockPathFor" must be a function/);
    assert.throws(() => createFileLock({ isHolderDead: 1 }), /"isHolderDead" must be a function/);
    assert.throws(() => createFileLock({ staleAfterMs: 0 }), /positive number or null/);
    assert.throws(() => createFileLock({ staleAfterMs: -5 }), /positive number or null/);
  });

  it('defaults the lock path to <target>.lock', () => {
    assert.equal(createFileLock({}).lockPathFor('/a/b'), '/a/b.lock');
  });
});

describe('exclusive acquire', () => {
  it('the first caller wins and the second is refused', () => {
    const lock = createFileLock({});
    const first = lock.acquire(target(), { payload: { who: 'a' } });
    assert.equal(first.ok, true);
    const second = lock.acquire(target(), { payload: { who: 'b' } });
    assert.equal(second.ok, false);
    assert.deepEqual(second.held, { who: 'a' }, 'refusal reports the live holder');
  });

  it('records the payload so a holder is identifiable', () => {
    const lock = createFileLock({});
    lock.acquire(target(), { payload: { pid: 42, owner: 'PR7' } });
    assert.deepEqual(lock.read(target()), { pid: 42, owner: 'PR7' });
  });

  it('creates a missing parent directory', () => {
    const lock = createFileLock({});
    const deep = path.join(base, 'a', 'b', 'c');
    assert.equal(lock.acquire(deep).ok, true);
    assert.equal(fs.existsSync(`${deep}.lock`), true);
  });

  it('re-acquires after release', () => {
    const lock = createFileLock({});
    assert.equal(lock.acquire(target()).ok, true);
    lock.release(target());
    assert.equal(lock.acquire(target()).ok, true);
  });
});

describe('staleness by age', () => {
  it('refuses a fresh lock and steals an aged-out one', () => {
    const lock = createFileLock({ staleAfterMs: 1000 });
    lock.acquire(target(), { payload: { who: 'old' } });
    assert.equal(lock.acquire(target()).ok, false, 'fresh lock is respected');

    const old = Date.now() - 60_000;
    fs.utimesSync(`${target()}.lock`, new Date(old), new Date(old));
    const res = lock.acquire(target(), { payload: { who: 'new' } });
    assert.equal(res.ok, true, 'aged-out lock is reclaimed');
    assert.deepEqual(lock.read(target()), { who: 'new' });
  });

  it('never ages out when staleAfterMs is unset — a claim is held until released', () => {
    const lock = createFileLock({});
    lock.acquire(target(), { payload: { who: 'a' } });
    const old = Date.now() - 10 * 365 * 24 * 3600 * 1000;
    fs.utimesSync(`${target()}.lock`, new Date(old), new Date(old));
    assert.equal(lock.acquire(target()).ok, false, 'age alone must not release a claim');
  });
});

describe('staleness by holder liveness', () => {
  it('reclaims a lock whose holder is dead', () => {
    const lock = createFileLock({ isHolderDead: (held) => held.pid !== process.pid });
    fs.writeFileSync(`${target()}.lock`, JSON.stringify({ pid: 999999 }));
    assert.equal(lock.acquire(target(), { payload: { pid: process.pid } }).ok, true);
  });

  it('respects a lock whose holder is alive', () => {
    const lock = createFileLock({ isHolderDead: () => false });
    fs.writeFileSync(`${target()}.lock`, JSON.stringify({ pid: 1 }));
    assert.equal(lock.acquire(target()).ok, false);
  });
});

describe('unreadable holder', () => {
  it('is refused rather than guessed at', () => {
    // Guessing about a lock you cannot read is how you get two writers.
    const lock = createFileLock({});
    fs.writeFileSync(`${target()}.lock`, '{ not json');
    const res = lock.acquire(target());
    assert.equal(res.ok, false);
    assert.deepEqual(res.held, { unreadable: true });
  });

  it('is taken over under force', () => {
    const lock = createFileLock({});
    fs.writeFileSync(`${target()}.lock`, '{ not json');
    assert.equal(lock.acquire(target(), { force: true, payload: { who: 'me' } }).ok, true);
  });
});

describe('force takeover', () => {
  it('takes a live lock and flags it as forced', () => {
    const lock = createFileLock({});
    lock.acquire(target(), { payload: { who: 'first' } });
    const res = lock.acquire(target(), { payload: { who: 'second' }, force: true });
    assert.equal(res.ok, true);
    assert.equal(res.forced, true, 'caller can tell it displaced someone');
    assert.deepEqual(lock.read(target()), { who: 'second' });
  });

  it('is not flagged forced when the lock was merely stale', () => {
    const lock = createFileLock({ staleAfterMs: 1 });
    lock.acquire(target(), { payload: { who: 'a' } });
    const old = Date.now() - 60_000;
    fs.utimesSync(`${target()}.lock`, new Date(old), new Date(old));
    assert.equal(lock.acquire(target(), { force: true }).forced, false);
  });
});

describe('ownership-checked release', () => {
  it('refuses to remove a lock owned by someone else', () => {
    // A process forced out must not delete the new holder's lock on exit.
    const lock = createFileLock({});
    lock.acquire(target(), { payload: { pid: 111 } });
    const removed = lock.release(target(), { ownedBy: (held) => held.pid === 222 });
    assert.equal(removed, false);
    assert.deepEqual(lock.read(target()), { pid: 111 }, 'holder survives');
  });

  it('removes its own lock', () => {
    const lock = createFileLock({});
    lock.acquire(target(), { payload: { pid: 111 } });
    assert.equal(lock.release(target(), { ownedBy: (held) => held.pid === 111 }), true);
    assert.equal(fs.existsSync(`${target()}.lock`), false);
  });

  it('release without an ownership check always removes', () => {
    const lock = createFileLock({});
    lock.acquire(target(), { payload: { pid: 111 } });
    assert.equal(lock.release(target()), true);
    assert.equal(fs.existsSync(`${target()}.lock`), false);
  });
});

describe('directory locks from earlier releases', () => {
  it('are treated as held, and cleared on takeover', () => {
    // The migration lock used to be a mkdir; upgrading in place must not wedge.
    const lock = createFileLock({ staleAfterMs: 1000 });
    fs.mkdirSync(`${target()}.lock`);
    assert.equal(lock.acquire(target()).ok, false, 'a dir lock still counts as held');

    const old = Date.now() - 60_000;
    fs.utimesSync(`${target()}.lock`, new Date(old), new Date(old));
    assert.equal(lock.acquire(target(), { payload: { who: 'new' } }).ok, true);
    assert.equal(fs.statSync(`${target()}.lock`).isFile(), true, 'replaced by a file lock');
  });
});

describe('readLock', () => {
  it('returns null for absent, unparseable and non-object bodies', () => {
    assert.equal(readLock(path.join(base, 'nope')), null);
    fs.writeFileSync(path.join(base, 'bad'), '{[');
    assert.equal(readLock(path.join(base, 'bad')), null);
    fs.writeFileSync(path.join(base, 'arr'), '[1,2]');
    assert.equal(readLock(path.join(base, 'arr')), null);
  });
});
