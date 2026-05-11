/**
 * Tests for CLI summary cleanup (GH-245 Task 7)
 *
 * Verifies that:
 * 1. CLI plan summary does not include "skip" or "stepsSkipped" keys
 * 2. Comments in workflow-definition.js and step-registry.js do not reference SKIP
 *
 * Uses node:test + node:assert/strict.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('CLI summary cleanup (GH-245 Task 7)', () => {
  describe('cli.js summary object', () => {
    it('should not include "skip" key in summary', () => {
      // Read cli.js source and check the summary object construction
      const cliSource = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf-8');

      // The summary object should not have a skip counter
      // Check for `skip:` in the summary construction block (lines ~169-179)
      const summaryBlock = cliSource.match(/result\.summary\s*=\s*\{[\s\S]*?\};/);
      assert.ok(summaryBlock, 'Should find summary assignment block');

      // Should not contain skip key
      assert.ok(!summaryBlock[0].includes('skip:'), 'Summary should not contain "skip:" counter');
    });

    it('should not include "stepsSkipped" key in summary', () => {
      const cliSource = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf-8');

      const summaryBlock = cliSource.match(/result\.summary\s*=\s*\{[\s\S]*?\};/);
      assert.ok(summaryBlock, 'Should find summary assignment block');

      assert.ok(
        !summaryBlock[0].includes('stepsSkipped'),
        'Summary should not contain "stepsSkipped" key'
      );
    });

    it('summary should still contain run, defer, and pending counters', () => {
      const cliSource = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf-8');

      const summaryBlock = cliSource.match(/result\.summary\s*=\s*\{[\s\S]*?\};/);
      assert.ok(summaryBlock, 'Should find summary assignment block');

      assert.ok(summaryBlock[0].includes('run:'), 'Summary should contain "run:" counter');
      assert.ok(summaryBlock[0].includes('defer:'), 'Summary should contain "defer:" counter');
      assert.ok(summaryBlock[0].includes('pending:'), 'Summary should contain "pending:" counter');
    });
  });

  describe('comment references to SKIP', () => {
    it('workflow-definition.js should not reference "SKIP/RUN" in comments', () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'workflow-definition.js'), 'utf-8');

      // Line 193 originally has "SKIP/RUN" -- should be changed to "DEFER/RUN"
      assert.ok(
        !source.includes('SKIP/RUN'),
        'workflow-definition.js should not contain "SKIP/RUN" in comments'
      );
    });

    it('step-registry.js should not reference "SKIP/RUN/DEFER" in comments', () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'step-registry.js'), 'utf-8');

      // Line 94 originally has "SKIP/RUN/DEFER" -- should be changed to "RUN/DEFER"
      assert.ok(
        !source.includes('SKIP/RUN/DEFER'),
        'step-registry.js should not contain "SKIP/RUN/DEFER" in comments'
      );
    });
  });
});
