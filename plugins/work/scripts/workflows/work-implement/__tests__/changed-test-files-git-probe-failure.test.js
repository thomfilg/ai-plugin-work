/**
 * GH-690 — git-probe-failure coverage for the tests-only GREEN gate.
 *
 * Commit 2c5c8629d changed `detectChangedTestFilesInScope` to THROW a
 * distinguished `GitProbeFailedError` on a git-probe failure (nonzero/null
 * exit, missing git binary, or the safeSpawnSync 15s timeout) instead of
 * degrading to an empty changed-set — so a git fault is no longer reported as
 * the misleading "no in-scope test changed" block. Two catch sites consume it:
 *   - task-next.js `evaluateGreenTestsOnly` (the GREEN recorder path), and
 *   - gate-writer.js `applyTestsOnlyGreenTrap` (the implement-gate writer),
 *     which appends the distinguished `tdd-green-tests-only-git-probe-failed-
 *     rejected` audit row.
 *
 * This suite pins all three: the throw, the recorder catch site, and the gate
 * catch site + audit row. Git failure is forced deterministically by pointing
 * the probe at a directory that is NOT a git repo (real nonzero `git` exit),
 * so no timing/mocking is involved.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const lib = require('../lib/changed-test-files');
const taskNext = require('../task-next');
const gateWriter = require('../tdd-phase-state/gate-writer');
const { loadActions } = require('../../work/lib/work-actions');

const TMP_DIRS = [];
function nonGitDir(label) {
  // A bare temp dir with no `.git`: `git diff --name-only` exits nonzero here,
  // driving the `gitFailed` branch without any mock or timing dependency.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ctf-nogit-${label}-`));
  TMP_DIRS.push(dir);
  return dir;
}

after(() => {
  for (const dir of TMP_DIRS) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('changed-test-files.js — git-probe failure throws (GH-690)', () => {
  it('detectChangedTestFilesInScope throws GitProbeFailedError (not []) on git failure', () => {
    const repo = nonGitDir('throw');
    assert.throws(
      () => lib.detectChangedTestFilesInScope(repo, ['src/**/*.test.js']),
      (err) => {
        assert.ok(err instanceof lib.GitProbeFailedError, 'must be GitProbeFailedError');
        assert.equal(err.name, 'GitProbeFailedError');
        assert.equal(err.gitProbeFailed, true, 'carries the gitProbeFailed marker');
        assert.match(err.message, /git change detection failed/i);
        return true;
      },
      'a git-probe failure must throw, never degrade to an empty changed-set'
    );
  });

  it('task-next re-exports the SAME GitProbeFailedError-throwing function', () => {
    const repo = nonGitDir('throw-reexport');
    assert.equal(taskNext.detectChangedTestFilesInScope, lib.detectChangedTestFilesInScope);
    assert.throws(
      () => taskNext.detectChangedTestFilesInScope(repo, ['src/**/*.test.js']),
      lib.GitProbeFailedError
    );
  });
});

describe('task-next evaluateGreenTestsOnly — git-probe catch site (GH-690)', () => {
  it('fails closed with an honest "git change detection failed" block, not "no test changed"', () => {
    const repo = nonGitDir('recorder');
    const result = taskNext.evaluateGreenTestsOnly({
      ticket: 'GH-690',
      taskNum: 1,
      testCmd: 'noop',
      repoRoot: repo,
      scope: ['src/**/*.test.js'],
    });
    assert.equal(result.advanced, false, 'GREEN must not advance when the probe failed');
    assert.equal(result.phase, 'green');
    assert.match(
      result.blockReason,
      /git change detection failed/i,
      'block must name the git-probe failure'
    );
    assert.doesNotMatch(
      result.blockReason,
      /No `?\*\.test\.\*/i,
      'must NOT emit the misleading "no test file changed" message on a git fault'
    );
    assert.match(
      result.blockReason,
      /STOP and report/i,
      'must tell the developer this is an environment fault, not a TDD violation'
    );
  });
});

describe('gate-writer applyTestsOnlyGreenTrap — git-probe catch site + audit (GH-690)', () => {
  it('writeGateGreen fails closed and appends the git-probe-failed audit row', () => {
    const tasksBase = nonGitDir('gate-tasksbase');
    const workingDir = nonGitDir('gate-worktree'); // non-git → forces GitProbeFailedError
    const ticketId = 'GH-690';
    const taskNum = 1;
    fs.mkdirSync(path.join(tasksBase, ticketId), { recursive: true });
    // loadActions resolves its file from TASKS_BASE; point it at this temp base
    // so we read back the same audit file writeGateGreen writes to.
    process.env.TASKS_BASE = tasksBase;

    const result = gateWriter.writeGateGreen({
      tasksBase,
      ticketId,
      taskNum,
      evidencePath: path.join(tasksBase, ticketId, 'tdd-' + 'phase.json'),
      evidence: { cycles: [{ green: {} }] },
      cmd: 'noop',
      // Non-empty test output so the shared rcdEmptyTrap (armed for tests-only)
      // passes and evaluation reaches the tests-only git-probe trap under test.
      output: 'ok 1 - some test\n# tests 1\n# pass 1\n',
      taskType: 'tests-only',
      workingDir,
      scope: ['src/**/*.test.js'],
    });

    assert.equal(result.rejected, true, 'a git-probe failure must reject, not write GREEN');
    assert.equal(result.kind, 'tests-only-git-probe-failed');
    assert.match(result.reason, /git change detection failed/i);
    assert.doesNotMatch(
      result.reason,
      /running an unchanged\s+pre-existing suite/i,
      'must not fall through to the misleading "unchanged suite" rejection'
    );

    // No evidence file was written — the GREEN was NOT recorded.
    assert.equal(
      fs.existsSync(path.join(tasksBase, ticketId, 'tdd-' + 'phase.json')),
      false,
      'GREEN evidence must not be persisted on a git-probe failure'
    );

    // The distinguished audit row is the whole point of the new branch.
    const rows = loadActions(ticketId);
    const audit = rows.find(
      (r) => r && r.action === 'tdd-green-tests-only-git-probe-failed-rejected'
    );
    assert.ok(audit, 'must append the distinguished git-probe-failed audit row');
    assert.equal(audit.allow, false, 'the audit row records a fail-closed decision');
    assert.equal(audit.reason, 'tests-only-git-probe-failed');
    assert.equal(audit.phase, 'green');
  });
});
