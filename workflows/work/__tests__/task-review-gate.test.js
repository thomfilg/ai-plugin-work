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
    const { computeTaskDiff } = require('../task-review-gate');
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

  it('falls back to base branch when .last-commit-sha file is missing', () => {
    const { computeTaskDiff } = require('../task-review-gate');
    // No .last-commit-sha file written
    const result = computeTaskDiff(tasksDir, 'T-2');
    assert.strictEqual(result.head, 'HEAD');
    // base should be a branch reference (e.g., origin/main), not a 40-char SHA
    assert.ok(
      result.base.includes('/') || result.base === 'origin/main',
      `Expected base branch fallback, got: ${result.base}`
    );
    assert.ok(result.fallback === true, 'Should indicate fallback was used');
  });

  it('falls back to base branch when SHA is not 40-char hex', () => {
    const { computeTaskDiff } = require('../task-review-gate');
    fs.writeFileSync(path.join(tasksDir, '.last-commit-sha'), 'not-a-valid-sha');
    const result = computeTaskDiff(tasksDir, 'T-3');
    assert.strictEqual(result.head, 'HEAD');
    assert.ok(result.fallback === true, 'Should indicate fallback was used');
  });

  it('falls back to base branch when SHA is not an ancestor of HEAD', () => {
    const { computeTaskDiff } = require('../task-review-gate');
    const fakeSha = 'b'.repeat(40);
    fs.writeFileSync(path.join(tasksDir, '.last-commit-sha'), fakeSha);

    // Mock execFileSync to simulate non-ancestor (exit code 1)
    const cp = require('child_process');
    const origExecFileSync = cp.execFileSync;
    cp.execFileSync = (cmd, args, opts) => {
      if (cmd === 'git' && args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        const err = new Error('not ancestor');
        err.status = 1;
        throw err;
      }
      return origExecFileSync(cmd, args, opts);
    };

    try {
      const result = computeTaskDiff(tasksDir, 'T-4');
      assert.strictEqual(result.head, 'HEAD');
      assert.ok(result.fallback === true, 'Should indicate fallback was used');
    } finally {
      cp.execFileSync = origExecFileSync;
    }
  });

  it('trims whitespace from SHA file contents', () => {
    const { computeTaskDiff } = require('../task-review-gate');
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
    const { executeTaskReview } = require('../task-review-gate');
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
    const { executeTaskReview } = require('../task-review-gate');
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
    const { executeTaskReview } = require('../task-review-gate');
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
    const { executeTaskReview } = require('../task-review-gate');
    const deps = {
      runTestsReview: () => ({ passed: false, summary: 'Missing tests' }),
      runCodeReview: () => ({ passed: false, summary: 'Bad patterns' }),
    };

    const result = executeTaskReview(tasksDir, 'T-13', deps);
    assert.strictEqual(result.passed, false);
    assert.ok(result.reasons.length >= 2);
  });

  it('writes review artifacts to tasksDir', () => {
    const { executeTaskReview } = require('../task-review-gate');
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
