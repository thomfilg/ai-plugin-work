/**
 * check-setup-evidence-stale.test.js — echo-6842
 *
 * The /check report cache is keyed on `git diff <base>...HEAD -w`, so HEAD can
 * move without the hash moving: a rebase, an amend, an empty commit, a
 * whitespace-only commit. The orchestrator's check-drift gate keys off the
 * HEAD SHA, so those are precisely the cases where it invalidates the check
 * evidence and expects /check to run again.
 *
 * If the cache reported a hit there, /check would skip the agents, no report
 * would be rewritten, `isEvidenceStale` would stay true and the workflow would
 * sit at check forever — the same deadlock one layer down from the archival
 * that caused it. An invalidated step must always be a cache miss.
 *
 * Uses node:test + node:assert/strict.
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { checkReportsCache } = require(path.join(__dirname, '..', 'hooks', 'check-setup'));
const { markEvidenceStale } = require(
  path.join(__dirname, '..', '..', 'work', 'lib', 'evidence-staleness')
);
const { STEPS } = require(path.join(__dirname, '..', '..', 'work', 'step-registry'));

const HASH = 'abc123def456';
const TRACKED = ['tests.check.md', 'code-review.check.md', 'completion.check.md'];

let reportFolder;

function writeReports() {
  fs.writeFileSync(
    path.join(reportFolder, 'README.md'),
    `# Reports\n\n**Changes Hash:** ${HASH}\n`
  );
  for (const file of TRACKED) {
    fs.writeFileSync(path.join(reportFolder, file), '**Status:** APPROVED\n');
  }
}

/** Persist a stale mark the way a transition would. */
function invalidate() {
  const ws = { ticketId: 'ECHO-6842' };
  markEvidenceStale(ws, STEPS.check, reportFolder, TRACKED, 'check-drift');
  fs.writeFileSync(path.join(reportFolder, '.work-state.json'), JSON.stringify(ws, null, 2));
}

describe('check-setup cache honours an invalidated check step (echo-6842)', () => {
  beforeEach(() => {
    reportFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'check-setup-stale-'));
    writeReports();
  });
  afterEach(() => fs.rmSync(reportFolder, { recursive: true, force: true }));

  it('hits the cache on an unchanged hash while the evidence is valid', () => {
    const result = checkReportsCache(reportFolder, HASH);
    assert.equal(result.cached, true, 'unchanged diff must still skip the agents');
  });

  it('misses on the SAME hash once the orchestrator invalidated the evidence', () => {
    invalidate();

    const result = checkReportsCache(reportFolder, HASH);
    assert.equal(
      result.cached,
      false,
      'a rebase/amend leaves the -w diff identical — the cache must not skip the re-run ' +
        'the drift gate asked for, or the stale mark can never clear'
    );
    assert.match(result.reason, /invalidated/i);
  });

  it('hits again once /check rewrote the reports', async () => {
    invalidate();
    await new Promise((resolve) => setTimeout(resolve, 10));
    writeReports(); // the re-dispatched agents overwrite in place

    assert.equal(checkReportsCache(reportFolder, HASH).cached, true);
  });

  it('still misses on a hash mismatch, invalidated or not', () => {
    assert.equal(checkReportsCache(reportFolder, 'ffffffffffff').cached, false);
    invalidate();
    assert.equal(checkReportsCache(reportFolder, 'ffffffffffff').cached, false);
  });

  it('fails open when there is no work state to read', () => {
    // No .work-state.json — a /check run outside the orchestrator must be
    // unaffected by this rule.
    assert.equal(checkReportsCache(reportFolder, HASH).cached, true);
  });
});
