/**
 * task-review-gate.test.js — Tests for task-review-gate.js (GH-211)
 *
 * Covers:
 *   - computeTaskDiff: SHA validation, ancestor check, fallback behavior
 *   - executeTaskReview: pass/fail aggregation, reasons, artifact writing
 */

'use strict';

const { describe, it, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEMP = path.join(os.tmpdir(), 'task-review-gate-test-' + process.pid);
let testCount = 0;
let tasksDir;

beforeEach(() => {
  testCount++;
  tasksDir = path.join(TEMP, `T-${testCount}`);
  fs.mkdirSync(tasksDir, { recursive: true });
});

after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

// ─── computeTaskDiff ──────────────────────────────────────────────────────────

describe('computeTaskDiff', () => {
  it('returns { base, head } when .last-commit-sha contains a valid ancestor SHA', () => {
    const { computeTaskDiff } = require('../gates/task-review-gate');
    // Write a valid 40-char hex SHA
    const fakeSha = 'a'.repeat(40);
    fs.writeFileSync(path.join(tasksDir, '.last-commit-sha'), fakeSha);

    // Mock execFileSync to simulate successful ancestor check
    const cp = require('child_process');
    const origExecFileSync = cp.execFileSync;
    cp.execFileSync = (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        return ''; // exit 0 = is ancestor
      }
      return origExecFileSync(cmd, args, opts);
    };

    try {
      const result = computeTaskDiff(tasksDir, 'T-1');
      assert.deepStrictEqual(result, { base: fakeSha, head: 'HEAD' });
    } finally {
      cp.execFileSync = origExecFileSync;
    }
  });

  // ─── GH-693: fallback matrix — missing/invalid/non-ancestor SHA must never
  // pass on an empty diff. Zero commits ahead of base (or a git failure)
  // blocks; commits ahead re-derive the base from the merge-base. ───────────

  /**
   * Mock git for the GH-693 fallback matrix:
   *   - revList: number, or an Error to simulate `git rev-list` failing
   *   - mergeBase: 40-char SHA, or an Error to simulate `git merge-base` failing
   *   - isAncestor: whether `merge-base --is-ancestor` succeeds (default false)
   */
  function withGitMock({ revList, mergeBase, isAncestor = false } = {}, fn) {
    const cp = require('child_process');
    const origExecFileSync = cp.execFileSync;
    cp.execFileSync = (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'rev-list' && args[1] === '--count') {
        if (revList instanceof Error) throw revList;
        return `${revList}\n`;
      }
      if (cmd === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        if (isAncestor) return '';
        const err = new Error('not ancestor');
        err.status = 1;
        throw err;
      }
      if (cmd === 'git' && args[0] === 'merge-base') {
        if (mergeBase instanceof Error) throw mergeBase;
        return `${mergeBase}\n`;
      }
      return origExecFileSync(cmd, args, opts);
    };
    try {
      return fn();
    } finally {
      cp.execFileSync = origExecFileSync;
    }
  }

  it('blocks when .last-commit-sha is missing and zero commits are ahead of base (GH-693)', () => {
    const { computeTaskDiff } = require('../gates/task-review-gate');
    // No .last-commit-sha file written
    withGitMock({ revList: 0 }, () => {
      const result = computeTaskDiff(tasksDir, 'T-2');
      assert.strictEqual(result.blocked, true, 'Zero commits ahead must block, not fall back');
      assert.match(result.reason, /no commits ahead/);
      assert.match(result.reason, /\.last-commit-sha/);
      assert.strictEqual(result.base, undefined, 'Blocked result must not carry a diff range');
    });
  });

  it('re-derives the base from the merge-base when SHA is missing but commits are ahead', () => {
    const { computeTaskDiff } = require('../gates/task-review-gate');
    const mergeBase = 'd'.repeat(40);
    withGitMock({ revList: 2, mergeBase }, () => {
      const result = computeTaskDiff(tasksDir, 'T-2b');
      assert.deepStrictEqual(result, { base: mergeBase, head: 'HEAD', fallback: true });
    });
  });

  it('falls back to the base branch name when merge-base fails but commits are ahead', () => {
    const { computeTaskDiff } = require('../gates/task-review-gate');
    withGitMock({ revList: 1, mergeBase: new Error('merge-base failed') }, () => {
      const result = computeTaskDiff(tasksDir, 'T-2c');
      assert.strictEqual(result.head, 'HEAD');
      assert.ok(result.fallback === true, 'Should indicate fallback was used');
      assert.ok(
        result.base.includes('/') || result.base === 'origin/main',
        `Expected base branch fallback, got: ${result.base}`
      );
    });
  });

  it('blocks when git rev-list fails (fail closed)', () => {
    const { computeTaskDiff } = require('../gates/task-review-gate');
    withGitMock({ revList: new Error('git failed') }, () => {
      const result = computeTaskDiff(tasksDir, 'T-2d');
      assert.strictEqual(result.blocked, true, 'git failure must block, not fall back');
    });
  });

  it('invalid SHA follows the same matrix: blocked at zero, merge-base with commits ahead', () => {
    const { computeTaskDiff } = require('../gates/task-review-gate');
    fs.writeFileSync(path.join(tasksDir, '.last-commit-sha'), 'not-a-valid-sha');
    withGitMock({ revList: 0 }, () => {
      assert.strictEqual(computeTaskDiff(tasksDir, 'T-3').blocked, true);
    });
    const mergeBase = 'e'.repeat(40);
    withGitMock({ revList: 1, mergeBase }, () => {
      assert.deepStrictEqual(computeTaskDiff(tasksDir, 'T-3'), {
        base: mergeBase,
        head: 'HEAD',
        fallback: true,
      });
    });
  });

  it('non-ancestor SHA follows the same matrix: blocked at zero, merge-base with commits ahead', () => {
    const { computeTaskDiff } = require('../gates/task-review-gate');
    fs.writeFileSync(path.join(tasksDir, '.last-commit-sha'), 'b'.repeat(40));
    withGitMock({ revList: 0, isAncestor: false }, () => {
      assert.strictEqual(computeTaskDiff(tasksDir, 'T-4').blocked, true);
    });
    const mergeBase = 'f'.repeat(40);
    withGitMock({ revList: 3, mergeBase, isAncestor: false }, () => {
      assert.deepStrictEqual(computeTaskDiff(tasksDir, 'T-4'), {
        base: mergeBase,
        head: 'HEAD',
        fallback: true,
      });
    });
  });

  it('trims whitespace from SHA file contents', () => {
    const { computeTaskDiff } = require('../gates/task-review-gate');
    const fakeSha = 'c'.repeat(40);
    fs.writeFileSync(path.join(tasksDir, '.last-commit-sha'), `  ${fakeSha}\n`);

    const cp = require('child_process');
    const origExecFileSync = cp.execFileSync;
    cp.execFileSync = (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        return '';
      }
      return origExecFileSync(cmd, args, opts);
    };

    try {
      const result = computeTaskDiff(tasksDir, 'T-5');
      assert.deepStrictEqual(result, { base: fakeSha, head: 'HEAD' });
    } finally {
      cp.execFileSync = origExecFileSync;
    }
  });
});

// ─── executeTaskReview ────────────────────────────────────────────────────────

describe('executeTaskReview', () => {
  it('returns passed:true when both reviews pass', () => {
    const { executeTaskReview } = require('../gates/task-review-gate');
    const deps = {
      runTestsReview: () => ({ passed: true, summary: 'All tests pass' }),
      runCodeReview: () => ({ passed: true, summary: 'Code looks good' }),
    };

    const result = executeTaskReview(tasksDir, 'T-10', deps);
    assert.strictEqual(result.passed, true);
    assert.deepStrictEqual(result.reasons, []);
    assert.ok(result.testsResult);
    assert.ok(result.codeResult);
  });

  it('returns passed:false with reasons when tests review fails', () => {
    const { executeTaskReview } = require('../gates/task-review-gate');
    const deps = {
      runTestsReview: () => ({ passed: false, summary: 'Missing coverage for module X' }),
      runCodeReview: () => ({ passed: true, summary: 'Code looks good' }),
    };

    const result = executeTaskReview(tasksDir, 'T-11', deps);
    assert.strictEqual(result.passed, false);
    assert.ok(result.reasons.length > 0);
    assert.ok(result.reasons.some((r) => r.includes('tests')));
  });

  it('returns passed:false with reasons when code review fails', () => {
    const { executeTaskReview } = require('../gates/task-review-gate');
    const deps = {
      runTestsReview: () => ({ passed: true, summary: 'All tests pass' }),
      runCodeReview: () => ({ passed: false, summary: 'Security issue found' }),
    };

    const result = executeTaskReview(tasksDir, 'T-12', deps);
    assert.strictEqual(result.passed, false);
    assert.ok(result.reasons.length > 0);
    assert.ok(result.reasons.some((r) => r.includes('code')));
  });

  it('returns passed:false with multiple reasons when both reviews fail', () => {
    const { executeTaskReview } = require('../gates/task-review-gate');
    const deps = {
      runTestsReview: () => ({ passed: false, summary: 'Missing tests' }),
      runCodeReview: () => ({ passed: false, summary: 'Bad patterns' }),
    };

    const result = executeTaskReview(tasksDir, 'T-13', deps);
    assert.strictEqual(result.passed, false);
    assert.ok(result.reasons.length >= 2);
  });

  it('writes review artifacts to tasksDir', () => {
    const { executeTaskReview } = require('../gates/task-review-gate');
    const deps = {
      runTestsReview: () => ({ passed: true, summary: 'All tests pass' }),
      runCodeReview: () => ({ passed: true, summary: 'Code looks good' }),
    };

    executeTaskReview(tasksDir, 'T-14', deps);

    const testsArtifact = path.join(tasksDir, 'task-review-tests.md');
    const codeArtifact = path.join(tasksDir, 'task-review-code.md');
    assert.ok(fs.existsSync(testsArtifact), 'task-review-tests.md should be written');
    assert.ok(fs.existsSync(codeArtifact), 'task-review-code.md should be written');

    const testsContent = fs.readFileSync(testsArtifact, 'utf-8');
    const codeContent = fs.readFileSync(codeArtifact, 'utf-8');
    assert.ok(testsContent.includes('All tests pass'));
    assert.ok(codeContent.includes('Code looks good'));
  });
});
