'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function makeTmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-ledger-'));
  return dir;
}

function withHome(home, fn) {
  const prev = process.env.HOME;
  process.env.HOME = home;
  // Force fresh module each test so any module-level caches respect HOME
  const modPath = require.resolve('../inject-ledger');
  delete require.cache[modPath];
  try {
    const mod = require('../inject-ledger');
    return fn(mod);
  } finally {
    process.env.HOME = prev;
    delete require.cache[require.resolve('../inject-ledger')];
  }
}

function sessionDir(home) {
  return path.join(home, '.claude', 'synapsys', '.session');
}

test('loadLedger/saveLedger round-trip in isolated HOME', () => {
  const home = makeTmpHome();
  withHome(home, (ledger) => {
    const sid = 'session-abc';
    const data = {
      createdAt: new Date().toISOString(),
      sessionId: sid,
      memories: { foo: { injectedCount: 2, lastFullInjectAt: 1 } },
    };
    ledger.saveLedger(sid, data);
    const loaded = ledger.loadLedger(sid);
    assert.equal(loaded.memories.foo.injectedCount, 2);
    assert.equal(loaded.memories.foo.lastFullInjectAt, 1);
  });
});

test('resolveSessionId sanitizes and falls back via .current and hash', () => {
  const home = makeTmpHome();
  withHome(home, (ledger) => {
    // Valid id passes through
    const ok = ledger.resolveSessionId({ session_id: 'safe_id-123' });
    assert.equal(ok, 'safe_id-123');

    // Unsafe id is hashed, never used raw
    const bad = ledger.resolveSessionId({ session_id: '../evil/../path' });
    assert.notEqual(bad, '../evil/../path');
    assert.match(bad, /^[A-Za-z0-9_-]+$/);

    // No payload → uses .current if present
    const dir = sessionDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.current'), 'persisted-id');
    const fromCurrent = ledger.resolveSessionId({});
    assert.equal(fromCurrent, 'persisted-id');

    // No payload, no .current → computes hash + writes .current
    fs.rmSync(path.join(dir, '.current'));
    const hashed = ledger.resolveSessionId({});
    assert.match(hashed, /^[A-Za-z0-9_-]+$/);
    assert.equal(fs.readFileSync(path.join(dir, '.current'), 'utf8').trim(), hashed);
  });
});

test('loadLedger fail-open on malformed JSON and oversized file', () => {
  const home = makeTmpHome();
  withHome(home, (ledger) => {
    const sid = 'session-malformed';
    const dir = sessionDir(home);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${sid}.json`), '{not json');
    const loaded = ledger.loadLedger(sid);
    assert.deepEqual(loaded.memories, {});
    assert.ok(typeof loaded.createdAt === 'string');

    // Oversized > 64 KB
    const sid2 = 'session-big';
    const big = 'x'.repeat(70 * 1024);
    fs.writeFileSync(path.join(dir, `${sid2}.json`), big);
    const loaded2 = ledger.loadLedger(sid2);
    assert.deepEqual(loaded2.memories, {});

    // Missing → empty
    const loaded3 = ledger.loadLedger('never-existed');
    assert.deepEqual(loaded3.memories, {});
  });
});

test('gcStaleLedgers deletes old files, keeps fresh ones, never throws', () => {
  const home = makeTmpHome();
  withHome(home, (ledger) => {
    const dir = sessionDir(home);
    fs.mkdirSync(dir, { recursive: true });
    const oldPath = path.join(dir, 'old.json');
    const freshPath = path.join(dir, 'fresh.json');
    fs.writeFileSync(oldPath, '{}');
    fs.writeFileSync(freshPath, '{}');
    // Backdate old file by 10 days
    const tenDaysAgo = Date.now() - 10 * 24 * 60 * 60 * 1000;
    fs.utimesSync(oldPath, tenDaysAgo / 1000, tenDaysAgo / 1000);

    assert.doesNotThrow(() => ledger.gcStaleLedgers({ maxAgeMs: 7 * 24 * 60 * 60 * 1000 }));
    assert.equal(fs.existsSync(oldPath), false);
    assert.equal(fs.existsSync(freshPath), true);

    // Empty dir → no throw
    assert.doesNotThrow(() => ledger.gcStaleLedgers({ maxAgeMs: 1 }));
  });
});

test('recordInjection increments count; lastFullInjectAt updates only on full', () => {
  const home = makeTmpHome();
  withHome(home, (ledger) => {
    const sid = 'session-record';
    ledger.recordInjection(sid, 'mem-a', { full: true });
    let l = ledger.loadLedger(sid);
    assert.equal(l.memories['mem-a'].injectedCount, 1);
    assert.equal(l.memories['mem-a'].lastFullInjectAt, 1);

    ledger.recordInjection(sid, 'mem-a', { full: false });
    l = ledger.loadLedger(sid);
    assert.equal(l.memories['mem-a'].injectedCount, 2);
    // Unchanged — last full was at count 1
    assert.equal(l.memories['mem-a'].lastFullInjectAt, 1);

    ledger.recordInjection(sid, 'mem-a', { full: true });
    l = ledger.loadLedger(sid);
    assert.equal(l.memories['mem-a'].injectedCount, 3);
    assert.equal(l.memories['mem-a'].lastFullInjectAt, 3);
  });
});

test('resetLedgerForSession truncates to fresh empty ledger', () => {
  const home = makeTmpHome();
  withHome(home, (ledger) => {
    const sid = 'session-reset';
    ledger.recordInjection(sid, 'm', { full: true });
    let l = ledger.loadLedger(sid);
    assert.equal(l.memories.m.injectedCount, 1);

    ledger.resetLedgerForSession(sid);
    l = ledger.loadLedger(sid);
    assert.deepEqual(l.memories, {});
  });
});
