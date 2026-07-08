/**
 * Tests for check/lib/staleness.js — SHA-keyed staleness + severity gating
 * (GH-307, echo-5213-3, echo-5804-004, echo-5808-C).
 *
 * node:test + node:assert/strict; temp report folders via fs.mkdtempSync.
 * SHA probes are injected — no git required.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  extractReportHash,
  evaluateReports,
  blockingReports,
  assessTerminalState,
  recordCompletion,
} = require(path.join(__dirname, '..', 'lib', 'staleness'));

const HASH_A = 'aaaaaaaaaaaa';
const HASH_B = 'bbbbbbbbbbbb';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'staleness-test-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function writeReport(file, status, hash) {
  const lines = [];
  if (hash) lines.push(`**Changes Hash:** ${hash}`, '');
  lines.push(`Status: ${status}`, '', '# Report body');
  fs.writeFileSync(path.join(dir, file), lines.join('\n'));
}

function writeAllApproved(hash) {
  writeReport('tests.check.md', 'APPROVED', hash);
  writeReport('code-review.check.md', 'APPROVED', hash);
  writeReport('completion.check.md', 'COMPLETE', hash);
}

describe('extractReportHash', () => {
  it('extracts the Changes Hash header', () => {
    assert.equal(extractReportHash(`**Changes Hash:** ${HASH_A}\n\nStatus: APPROVED`), HASH_A);
    assert.equal(extractReportHash('**Changes Hash:** no-changes'), 'no-changes');
  });
  it('returns null when absent', () => {
    assert.equal(extractReportHash('Status: APPROVED'), null);
    assert.equal(extractReportHash(''), null);
  });
});

describe('evaluateReports', () => {
  it('parses status + hash match for every required report', () => {
    writeAllApproved(HASH_A);
    const reports = evaluateReports(dir, HASH_A);
    assert.equal(reports.length, 3);
    for (const r of reports) {
      assert.equal(r.present, true);
      assert.equal(r.status, 'APPROVED');
      assert.equal(r.hashMatch, true);
    }
  });

  it('marks absent reports MISSING and hash mismatches', () => {
    writeReport('code-review.check.md', 'NEEDS_WORK', HASH_B);
    const reports = evaluateReports(dir, HASH_A);
    const byFile = Object.fromEntries(reports.map((r) => [r.file, r]));
    assert.equal(byFile['tests.check.md'].status, 'MISSING');
    assert.equal(byFile['code-review.check.md'].status, 'NEEDS_WORK');
    assert.equal(byFile['code-review.check.md'].hashMatch, false);
  });
});

describe('blockingReports', () => {
  it('blocks NEEDS_WORK at the matching hash', () => {
    writeReport('code-review.check.md', 'NEEDS_WORK', HASH_A);
    const blocking = blockingReports(evaluateReports(dir, HASH_A));
    assert.equal(blocking.length, 1);
    assert.equal(blocking[0].file, 'code-review.check.md');
  });

  it('blocks NEEDS_WORK with no hash header (conservatively current)', () => {
    writeReport('code-review.check.md', 'NEEDS_WORK', null);
    assert.equal(blockingReports(evaluateReports(dir, HASH_A)).length, 1);
  });

  it('does NOT block a NEEDS_WORK report anchored to a DIFFERENT hash', () => {
    writeReport('code-review.check.md', 'NEEDS_WORK', HASH_B);
    assert.equal(blockingReports(evaluateReports(dir, HASH_A)).length, 0);
  });

  it('does not block APPROVED/MISSING reports', () => {
    writeAllApproved(HASH_A);
    assert.equal(blockingReports(evaluateReports(dir, HASH_A)).length, 0);
  });
});

describe('assessTerminalState', () => {
  it('stale when the changes hash drifted', () => {
    writeAllApproved(HASH_A);
    const res = assessTerminalState({ status: 'complete', changesHash: HASH_A }, dir, {
      currentHash: HASH_B,
      currentHead: null,
    });
    assert.equal(res.verdict, 'stale');
    assert.match(res.reasons[0], /sha-drift: changes hash/);
  });

  it('stale when HEAD drifted even with the same changes hash', () => {
    writeAllApproved(HASH_A);
    const res = assessTerminalState(
      { status: 'complete', changesHash: HASH_A, completedHeadSha: 'a'.repeat(40) },
      dir,
      { currentHash: HASH_A, currentHead: 'b'.repeat(40) }
    );
    assert.equal(res.verdict, 'stale');
    assert.match(res.reasons[0], /sha-drift: HEAD/);
  });

  it('prefers completedChangesHash over changesHash for the drift comparison', () => {
    writeAllApproved(HASH_A);
    const res = assessTerminalState(
      { status: 'complete', changesHash: 'unknown', completedChangesHash: HASH_A },
      dir,
      { currentHash: HASH_A, currentHead: null }
    );
    assert.equal(res.verdict, 'valid');
  });

  it('needs_work when SHAs match but a report is NEEDS_WORK at the current hash', () => {
    writeReport('tests.check.md', 'APPROVED', HASH_A);
    writeReport('code-review.check.md', 'NEEDS_WORK', HASH_A);
    writeReport('completion.check.md', 'COMPLETE', HASH_A);
    const res = assessTerminalState({ status: 'complete', changesHash: HASH_A }, dir, {
      currentHash: HASH_A,
      currentHead: null,
    });
    assert.equal(res.verdict, 'needs_work');
    assert.match(res.reasons[0], /code-review\.check\.md/);
  });

  it('valid when SHAs match and every present report passes', () => {
    writeAllApproved(HASH_A);
    const res = assessTerminalState({ status: 'complete', changesHash: HASH_A }, dir, {
      currentHash: HASH_A,
      currentHead: null,
    });
    assert.equal(res.verdict, 'valid');
  });

  it('fail-safe: unknown current hash never counts as drift', () => {
    writeAllApproved(HASH_A);
    const res = assessTerminalState({ status: 'complete', changesHash: HASH_A }, dir, {
      currentHash: null,
      currentHead: null,
    });
    assert.equal(res.verdict, 'valid');
  });
});

describe('recordCompletion', () => {
  it('records completedChangesHash + completedAt + injected HEAD', () => {
    const state = { changesHash: HASH_A };
    recordCompletion(state, { currentHead: 'c'.repeat(40) });
    assert.equal(state.completedChangesHash, HASH_A);
    assert.equal(state.completedHeadSha, 'c'.repeat(40));
    assert.ok(state.completedAt);
  });

  it('normalizes unknown hash to null', () => {
    const state = { changesHash: 'unknown' };
    recordCompletion(state, { currentHead: null });
    assert.equal(state.completedChangesHash, null);
  });
});

describe('11_output step — severity gate (echo-5804-004)', () => {
  const { runStep } = require(path.join(__dirname, '..', 'lib', 'step-registry'));

  it('returns needs_work (not complete) when a report is NEEDS_WORK at the current hash', () => {
    writeReport('tests.check.md', 'APPROVED', HASH_A);
    writeReport('code-review.check.md', 'NEEDS_WORK', HASH_A);
    writeReport('completion.check.md', 'COMPLETE', HASH_A);
    const state = {
      ticketId: 'GH-1',
      changesHash: HASH_A,
      setupResult: { reportFolder: dir },
    };
    const out = runStep('11_output', state, { tasksDir: dir });
    assert.equal(out.action, 'needs_work');
    assert.equal(state.status, 'needs_work');
    assert.ok(Array.isArray(state.reportStatuses));
    assert.match(out.reason, /code-review\.check\.md/);
  });

  it('completes and records completion SHAs when all reports pass', () => {
    writeAllApproved(HASH_A);
    fs.writeFileSync(path.join(dir, 'README.md'), '# Summary');
    const state = {
      ticketId: 'GH-1',
      changesHash: HASH_A,
      setupResult: { reportFolder: dir },
    };
    const out = runStep('11_output', state, { tasksDir: dir });
    assert.equal(out.action, 'complete');
    assert.equal(state.status, 'complete');
    assert.equal(state.completedChangesHash, HASH_A);
    assert.ok(state.completedAt);
  });
});
