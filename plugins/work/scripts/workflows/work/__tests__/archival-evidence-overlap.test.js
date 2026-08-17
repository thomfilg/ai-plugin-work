/**
 * archival-evidence-overlap.test.js — echo-6842
 *
 * The structural guard that stops the class of bug recurring: archival may
 * never target a file the SAME step's own evidence contract requires.
 *
 * `archivalPatterns[check]` was `/^.*\.check\.md$/` and
 * `evidenceRequirements[check]` names three `*.check.md` reports plus a
 * `qa-*.check.md` pattern. Archiving the check step therefore moved the
 * evidence `verifyCheck` and `validateCheckGate` read — so a rollback the
 * workflow could not undo left the gate reporting "Missing report:
 * tests.check.md" for files it had just moved into `runs/runN/`.
 *
 * These assertions are over the config, not over any code path, so they hold
 * for archival call sites that do not exist yet.
 *
 * Uses node:test + node:assert/strict.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const createWorkflowDefinition = require(path.join(__dirname, '..', 'workflow-definition'));
const { STEPS } = require(path.join(__dirname, '..', 'step-registry'));

const { workflow } = createWorkflowDefinition({
  TASKS_BASE: '/nonexistent',
  safeTicketPath: (id) => id,
  resolveGitHead: () => '',
});

describe('archivalPatterns never match the step evidence they would destroy', () => {
  it('no archival pattern matches its own step requiredFiles', () => {
    const { archivalPatterns, evidenceRequirements } = workflow;
    const overlaps = [];
    for (const [step, patterns] of Object.entries(archivalPatterns)) {
      for (const file of evidenceRequirements[step]?.requiredFiles || []) {
        for (const pattern of patterns) {
          if (pattern.test(file)) overlaps.push(`${step}: ${pattern} matches ${file}`);
        }
      }
    }
    assert.deepEqual(
      overlaps,
      [],
      `archival would destroy its own gate evidence:\n${overlaps.join('\n')}`
    );
  });

  it('no archival pattern matches a QA report the same step requires', () => {
    // Same trap, one requirement over: `qaReportPattern` is evidence too —
    // verifyCheck and the check gate's qa-reports rule both need at least one
    // qa-*.check.md when web apps are configured.
    const { archivalPatterns, evidenceRequirements } = workflow;
    const overlaps = [];
    for (const [step, patterns] of Object.entries(archivalPatterns)) {
      const qaPattern = evidenceRequirements[step]?.qaReportPattern;
      if (!qaPattern) continue;
      for (const sample of ['qa-feature-tester.check.md', 'qa-api-tester.check.md']) {
        if (!qaPattern.test(sample)) continue;
        for (const pattern of patterns) {
          if (pattern.test(sample)) overlaps.push(`${step}: ${pattern} matches ${sample}`);
        }
      }
    }
    assert.deepEqual(overlaps, [], overlaps.join('\n'));
  });

  it('every preserved pattern IS evidence — copying is for gate inputs only', () => {
    const { preservedArchivalPatterns, evidenceRequirements } = workflow;
    for (const [step, patterns] of Object.entries(preservedArchivalPatterns)) {
      const reqs = evidenceRequirements[step] || {};
      const evidence = [...(reqs.refreshedFiles || []), 'qa-feature-tester.check.md'];
      for (const pattern of patterns) {
        assert.ok(
          evidence.some((f) => pattern.test(f)),
          `${step}: ${pattern} preserves something that is not declared evidence`
        );
      }
    }
  });

  it('still archives check artifacts that are not gate evidence', () => {
    const patterns = workflow.archivalPatterns[STEPS.check];
    assert.ok(
      patterns.some((p) => p.test('dev-quality.check.md')),
      'non-evidence check reports must still be swept into runs/runN/'
    );
    assert.ok(patterns.some((p) => p.test('lint.check.md')));
  });
});
