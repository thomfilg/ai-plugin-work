/**
 * Tests for check-setup.js setupReportFolder purge guard (GH-611).
 *
 * The *.check.md purge must fire ONLY when a genuinely NEW check cycle starts
 * (no cycle marker, or the changes hash changed) — never while a cycle for
 * the same hash is in progress, where it would wipe reports the phase-1
 * agents just wrote.
 *
 * node:test + node:assert/strict; temp dirs via fs.mkdtempSync.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { setupReportFolder, shouldPurgeReports } = require('../check-setup');

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-setup-purge-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeReports() {
  fs.writeFileSync(path.join(dir, 'code-review.check.md'), 'Status: APPROVED');
  fs.writeFileSync(path.join(dir, 'completion.check.md'), 'Status: COMPLETE');
  fs.writeFileSync(path.join(dir, 'README.md'), '**Changes Hash:** aaa');
  fs.writeFileSync(path.join(dir, 'implement.md'), 'not a check artifact');
}

describe('setupReportFolder — cycle-keyed purge guard', () => {
  it('purges old reports and writes the cycle marker on a NEW cycle', () => {
    writeReports();
    const purged = setupReportFolder(dir, 'hash-1');
    assert.equal(purged, true);
    assert.equal(fs.existsSync(path.join(dir, 'code-review.check.md')), false);
    assert.equal(fs.existsSync(path.join(dir, 'README.md')), false);
    // non-check files are preserved
    assert.equal(fs.existsSync(path.join(dir, 'implement.md')), true);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.check-cycle.json'), 'utf8'));
    assert.equal(marker.changesHash, 'hash-1');
  });

  it('does NOT purge when a cycle for the same hash is already in progress', () => {
    setupReportFolder(dir, 'hash-1'); // starts the cycle
    writeReports(); // phase-1 agents write their reports mid-cycle
    const purged = setupReportFolder(dir, 'hash-1'); // e.g. concurrent re-run of setup
    assert.equal(purged, false);
    assert.equal(
      fs.readFileSync(path.join(dir, 'code-review.check.md'), 'utf8'),
      'Status: APPROVED'
    );
    assert.equal(
      fs.readFileSync(path.join(dir, 'completion.check.md'), 'utf8'),
      'Status: COMPLETE'
    );
  });

  it('purges again when the changes hash CHANGES (stale reports)', () => {
    setupReportFolder(dir, 'hash-1');
    writeReports();
    const purged = setupReportFolder(dir, 'hash-2');
    assert.equal(purged, true);
    assert.equal(fs.existsSync(path.join(dir, 'code-review.check.md')), false);
    const marker = JSON.parse(fs.readFileSync(path.join(dir, '.check-cycle.json'), 'utf8'));
    assert.equal(marker.changesHash, 'hash-2');
  });

  it('skips the purge when a concurrent setup holds the cycle lock', () => {
    writeReports();
    fs.writeFileSync(path.join(dir, '.check-cycle.lock'), String(process.pid));
    const purged = setupReportFolder(dir, 'hash-1');
    assert.equal(purged, false);
    assert.equal(fs.existsSync(path.join(dir, 'code-review.check.md')), true);
  });

  it('shouldPurgeReports: true without marker, false with matching marker', () => {
    assert.equal(shouldPurgeReports(dir, 'hash-1'), true);
    setupReportFolder(dir, 'hash-1');
    assert.equal(shouldPurgeReports(dir, 'hash-1'), false);
    assert.equal(shouldPurgeReports(dir, 'hash-2'), true);
  });

  it('still creates the screenshots folder when the purge is skipped', () => {
    setupReportFolder(dir, 'hash-1');
    fs.rmSync(path.join(dir, 'screenshots'), { recursive: true, force: true });
    setupReportFolder(dir, 'hash-1'); // same hash → no purge, but folders ensured
    assert.equal(fs.existsSync(path.join(dir, 'screenshots')), true);
  });
});
