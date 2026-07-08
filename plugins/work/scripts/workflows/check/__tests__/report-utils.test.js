/**
 * Tests for check/lib/report-utils.js (GH-611, GH-343).
 *
 * - reportPresent/reportStatus: 0-byte report counts as MISSING ('empty').
 * - writeReportAtomic: content lands atomically, no tmp litter.
 * - acquireLock/releaseLock: mutual exclusion, dead-pid reclamation,
 *   age-based staleness.
 *
 * node:test + node:assert/strict; temp dirs via fs.mkdtempSync.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  reportPresent,
  reportStatus,
  writeReportAtomic,
  acquireLock,
  releaseLock,
} = require('../lib/report-utils');

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-utils-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('reportPresent / reportStatus — 0-byte is missing', () => {
  it('absent file → not present, status absent', () => {
    const p = path.join(dir, 'code-review.check.md');
    assert.equal(reportPresent(p), false);
    assert.equal(reportStatus(p), 'absent');
  });

  it('0-byte file (clobber-race victim) → not present, status empty', () => {
    const p = path.join(dir, 'completion.check.md');
    fs.writeFileSync(p, '');
    assert.equal(reportPresent(p), false);
    assert.equal(reportStatus(p), 'empty');
  });

  it('non-empty file → present', () => {
    const p = path.join(dir, 'completion.check.md');
    fs.writeFileSync(p, 'Status: COMPLETE');
    assert.equal(reportPresent(p), true);
    assert.equal(reportStatus(p), 'present');
  });
});

describe('writeReportAtomic', () => {
  it('writes content and leaves no tmp files behind', () => {
    const p = path.join(dir, 'tests.check.md');
    writeReportAtomic(p, 'hello report');
    assert.equal(fs.readFileSync(p, 'utf8'), 'hello report');
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('overwrites an existing report atomically', () => {
    const p = path.join(dir, 'tests.check.md');
    fs.writeFileSync(p, 'old');
    writeReportAtomic(p, 'new content');
    assert.equal(fs.readFileSync(p, 'utf8'), 'new content');
  });

  it('creates missing parent directories', () => {
    const p = path.join(dir, 'nested', 'deep', 'r.check.md');
    writeReportAtomic(p, 'x');
    assert.equal(fs.readFileSync(p, 'utf8'), 'x');
  });
});

describe('acquireLock / releaseLock — mutual exclusion', () => {
  it('second acquire fails while the (live) lock is held', () => {
    const lock = path.join(dir, '.check-next.lock');
    assert.equal(acquireLock(lock), true);
    // Our own pid is alive and the file is fresh → held
    assert.equal(acquireLock(lock), false);
    releaseLock(lock);
    assert.equal(acquireLock(lock), true);
    releaseLock(lock);
  });

  it('reclaims a lock whose owning pid is dead', () => {
    const lock = path.join(dir, '.check-next.lock');
    // Spawn a process that exits immediately, so the pid is dead but plausible
    const { spawnSync } = require('child_process');
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    fs.writeFileSync(lock, String(child.pid));
    assert.equal(acquireLock(lock), true);
    releaseLock(lock);
  });

  it('reclaims a lock older than staleMs even when the pid is unparseable', () => {
    const lock = path.join(dir, '.check-next.lock');
    fs.writeFileSync(lock, 'not-a-pid');
    const past = new Date(Date.now() - 60000);
    fs.utimesSync(lock, past, past);
    assert.equal(acquireLock(lock, { staleMs: 30000 }), true);
    releaseLock(lock);
  });

  it('does NOT reclaim a fresh lock with an unparseable pid', () => {
    const lock = path.join(dir, '.check-next.lock');
    fs.writeFileSync(lock, 'not-a-pid');
    assert.equal(acquireLock(lock, { staleMs: 30000 }), false);
  });
});
