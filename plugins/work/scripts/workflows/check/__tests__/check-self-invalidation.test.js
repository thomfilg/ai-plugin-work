'use strict';

/**
 * Regression: /check must not invalidate itself.
 *
 * The livelock, end to end. `TASKS_BASE` may point inside the repository
 * (`<repo>/tasks/<TICKET>/`), and `commit-and-push.js` — the one sanctioned
 * commit path — stages with `git add -A`. So the `*.check.md` reports a
 * passing cycle just wrote become tracked files in the next commit. When the
 * changes hash and the HEAD comparison were computed over the whole diff:
 *
 *   agents approve → reports committed → hash moves → `shouldPurgeReports`
 *   deletes those very reports and every agent is re-dispatched → they
 *   approve again → … forever
 *
 * The check's own output was an input to its freshness test. These tests pin
 * both halves of the fix: artifact-only movement changes nothing, and a real
 * code change still invalidates everything it used to.
 *
 * Run with: node --test workflows/check/__tests__/check-self-invalidation.test.js
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const staleness = require('../lib/staleness');
const { shouldPurgeReports, writeCycleMarker } = require('../lib/report-cycle');

const REPORTS = ['tests.check.md', 'code-review.check.md', 'completion.check.md'];

describe('/check self-invalidation (the report-commit livelock)', () => {
  let repo;
  let reportFolder;
  let approvedHead;
  let approvedHash;
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();

  /** One full check cycle: hash the tree, mark the cycle, write passing reports. */
  function runCheckCycle() {
    const hash = staleness.computeChangesHash(repo);
    writeCycleMarker(reportFolder, hash);
    for (const file of REPORTS) {
      fs.writeFileSync(
        path.join(reportFolder, file),
        `**Status:** APPROVED\n**Changes Hash:** ${hash}\n**Head:** ${git('rev-parse', 'HEAD')}\n`
      );
    }
    return hash;
  }

  before(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'check-selfinval-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    fs.writeFileSync(path.join(repo, 'src.js'), 'module.exports = 1;\n');
    git('add', '-A');
    git('commit', '-qm', 'base');
    // The base the changes hash diffs against (config probes origin/* refs).
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-qb', 'feature');
    fs.writeFileSync(path.join(repo, 'src.js'), 'module.exports = 2;\n');
    git('add', '-A');
    git('commit', '-qm', 'feat: the change under review');

    // TASKS_BASE inside the repo — the layout that livelocked.
    reportFolder = path.join(repo, 'tasks', 'GH-1');
    fs.mkdirSync(reportFolder, { recursive: true });

    approvedHash = runCheckCycle();
    approvedHead = git('rev-parse', 'HEAD');
    git('add', '-A'); // exactly what commit-and-push.js does
    git('commit', '-qm', 'chore: sweep in the check reports');
  });

  after(() => fs.rmSync(repo, { recursive: true, force: true }));

  it('committing the reports does not move the changes hash', () => {
    assert.notEqual(approvedHash, 'no-changes', 'guard: the fixture must have a real diff');
    assert.equal(staleness.computeChangesHash(repo), approvedHash);
  });

  it('the reports are not purged, so no agent is re-dispatched', () => {
    assert.equal(shouldPurgeReports(reportFolder, staleness.computeChangesHash(repo)), false);
  });

  it('the terminal state stays valid — the passing check is not re-opened', () => {
    const state = { completedChangesHash: approvedHash, completedHeadSha: approvedHead };
    const assessed = staleness.assessTerminalState(state, reportFolder, { cwd: repo });

    assert.equal(assessed.verdict, 'valid', JSON.stringify(assessed.reasons));
    assert.deepEqual(assessed.reasons, []);
  });

  it('the cycle converges: a second pass over the same code is a no-op', () => {
    // Without the fix each pass rewrote the reports, whose commit moved the
    // hash again — this loop never reached a fixed point.
    for (let i = 0; i < 3; i++) {
      assert.equal(shouldPurgeReports(reportFolder, staleness.computeChangesHash(repo)), false);
      git('add', '-A');
      // Nothing left to stage once the reports are in — the tree is stable.
      assert.equal(git('status', '--porcelain'), '');
    }
  });

  describe('and a REAL code change still invalidates everything', () => {
    let codeHash;

    before(() => {
      fs.writeFileSync(path.join(repo, 'src.js'), 'module.exports = 3;\n');
      git('add', '-A');
      git('commit', '-qm', 'feat: more code');
      codeHash = staleness.computeChangesHash(repo);
    });

    it('moves the changes hash', () => {
      assert.notEqual(codeHash, approvedHash);
    });

    it('purges the stale reports and starts a new cycle', () => {
      assert.equal(shouldPurgeReports(reportFolder, codeHash), true);
    });

    it('marks the terminal state stale on both the hash and HEAD', () => {
      const state = { completedChangesHash: approvedHash, completedHeadSha: approvedHead };
      const assessed = staleness.assessTerminalState(state, reportFolder, { cwd: repo });

      assert.equal(assessed.verdict, 'stale');
      assert.ok(
        assessed.reasons.some((r) => r.includes('changes hash')),
        `expected a changes-hash reason, got ${JSON.stringify(assessed.reasons)}`
      );
      assert.ok(
        assessed.reasons.some((r) => r.includes('HEAD')),
        `expected a HEAD reason, got ${JSON.stringify(assessed.reasons)}`
      );
    });
  });
});
