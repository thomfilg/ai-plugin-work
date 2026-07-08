'use strict';

/**
 * Parameterized integration test for Task 4 — migrate the remaining 11 *-next.js
 * runners to the createPhaseRunner factory.
 *
 * For each runner, this test asserts:
 *   - the source file requires the create-phase-runner module
 *   - the source file calls createPhaseRunner(...)
 *   - the source file contains a factory-contract comment (mentions "factory")
 *   - the wrapper is thin (< 60 lines)
 *
 * RED-phase expectation: today every one of the 11 runners still inlines its
 * own main()/orchestrator body and therefore fails every assertion. Once each
 * runner is migrated to the factory (GREEN phase of Task 4) all assertions
 * must pass.
 *
 * Scope: Task 4 — the 11 enumerated runners. (brief-next.js was migrated in
 * Task 3 and is intentionally excluded.)
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_WORKFLOWS = path.resolve(__dirname, '..', '..', '..');

const MIGRATED_RUNNERS = [
  { name: 'spec', file: 'work-spec/spec-next.js' },
  { name: 'ci', file: 'work-ci/ci-next.js' },
  { name: 'tasks', file: 'work-tasks/tasks-next.js' },
  { name: 'task-review', file: 'work-task-review/task-review-next.js' },
  { name: 'reports', file: 'work-reports/reports-next.js' },
  { name: 'pr-review', file: 'work-pr-reviewer/pr-review-next.js' },
  { name: 'completion', file: 'work-completion-checker/completion-next.js' },
  { name: 'cleanup', file: 'work-cleanup/cleanup-next.js' },
  { name: 'qa', file: 'work-qa-feature-tester/qa-next.js' },
  { name: 'pr', file: 'work-pr-step/pr-next.js' },
  { name: 'code', file: 'work-code-checker/code-next.js' },
];

describe('Task 4 — migrated *-next.js runners delegate to createPhaseRunner', () => {
  for (const runner of MIGRATED_RUNNERS) {
    describe(`${runner.name}-next.js`, () => {
      const fullPath = path.join(REPO_WORKFLOWS, runner.file);

      it('exists on disk', () => {
        assert.equal(fs.existsSync(fullPath), true, `expected ${runner.file} to exist`);
      });

      it('requires the create-phase-runner factory module', () => {
        const src = fs.readFileSync(fullPath, 'utf8');
        assert.match(
          src,
          /require\(['"][^'"]*lib\/phase-runner\/create-phase-runner['"]\)/,
          `${runner.file} must require the create-phase-runner factory module`
        );
      });

      it('calls createPhaseRunner(...)', () => {
        const src = fs.readFileSync(fullPath, 'utf8');
        assert.match(
          src,
          /createPhaseRunner\s*\(/,
          `${runner.file} must invoke createPhaseRunner(...)`
        );
      });

      it('contains a factory-contract comment', () => {
        const src = fs.readFileSync(fullPath, 'utf8');
        // Look for the word "factory" in a comment line. Matches either
        // // ... factory ...   or   * ... factory ...
        const hasFactoryComment = /(^|\n)\s*(\/\/|\*).*factory/i.test(src);
        assert.ok(
          hasFactoryComment,
          `${runner.file} must contain a comment mentioning the factory contract`
        );
      });

      it('is a thin wrapper (< 60 lines)', () => {
        const src = fs.readFileSync(fullPath, 'utf8');
        const lines = src.split('\n').length;
        assert.ok(
          lines < 60,
          `${runner.file} should be a thin wrapper < 60 lines, got ${lines}`
        );
      });
    });
  }
});
