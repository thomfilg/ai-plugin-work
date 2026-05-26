/**
 * Tests for workflows/work/lib/gherkin-coverage.js
 *
 * Coverage validation for Gherkin scenarios against tasks.md and test files.
 *
 * Run: node --test workflows/work/lib/__tests__/gherkin-coverage.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { validateTaskCoverage, validateTestCoverage } = require('../gherkin-coverage');

// ─── validateTaskCoverage ───────────────────────────────────────────────────

describe('gherkin-coverage: validateTaskCoverage', () => {
  it('detects uncovered scenarios', () => {
    const scenarios = [
      { name: 'Scenario A', tags: ['@integration'], steps: [{ keyword: 'Given', text: 'x' }, { keyword: 'When', text: 'y' }, { keyword: 'Then', text: 'z' }] },
      { name: 'Scenario B', tags: ['@unit'], steps: [{ keyword: 'Given', text: 'a' }, { keyword: 'When', text: 'b' }, { keyword: 'Then', text: 'c' }] },
      { name: 'Scenario C', tags: ['@e2e'], steps: [{ keyword: 'Given', text: 'd' }, { keyword: 'When', text: 'e' }, { keyword: 'Then', text: 'f' }] },
    ];
    const tasksContent = [
      '## Task 1',
      'Covers Scenario A',
      '',
      '## Task 2',
      'Covers Scenario B',
    ].join('\n');

    const result = validateTaskCoverage(scenarios, tasksContent);
    assert.equal(result.valid, false);
    assert.ok(result.uncovered.includes('Scenario C'));
    assert.equal(result.uncovered.length, 1);
  });

  it('passes when all scenarios are covered', () => {
    const scenarios = [
      { name: 'Scenario A', tags: ['@integration'], steps: [{ keyword: 'Given', text: 'x' }, { keyword: 'When', text: 'y' }, { keyword: 'Then', text: 'z' }] },
      { name: 'Scenario B', tags: ['@unit'], steps: [{ keyword: 'Given', text: 'a' }, { keyword: 'When', text: 'b' }, { keyword: 'Then', text: 'c' }] },
    ];
    const tasksContent = [
      '## Task 1',
      'Covers Scenario A and Scenario B',
    ].join('\n');

    const result = validateTaskCoverage(scenarios, tasksContent);
    assert.equal(result.valid, true);
    assert.deepEqual(result.uncovered, []);
  });

  it('matches scenario names case-insensitively', () => {
    const scenarios = [
      { name: 'User Can Login', tags: ['@integration'] },
      { name: 'Admin Dashboard Loads', tags: ['@e2e'] },
    ];
    const tasksContent = '## Task 1\nImplement user can login\n## Task 2\nImplement admin dashboard loads';
    const result = validateTaskCoverage(scenarios, tasksContent);
    assert.equal(result.valid, true);
    assert.deepEqual(result.uncovered, []);
  });
});

// ─── validateTestCoverage ───────────────────────────────────────────────────

describe('gherkin-coverage: validateTestCoverage', () => {
  it('matches scenario to correct test type with tag match', () => {
    const scenarios = [
      { name: 'Request password reset email', tags: ['@e2e'], steps: [{ keyword: 'Given', text: 'x' }, { keyword: 'When', text: 'y' }, { keyword: 'Then', text: 'z' }] },
    ];
    const testFiles = [
      { path: 'src/__tests__/password-reset.e2e.test.js', content: 'test("Request password reset email", () => {})' },
    ];

    const result = validateTestCoverage(scenarios, testFiles);
    assert.equal(result.valid, true);
    assert.ok(result.covered.length > 0);
    assert.equal(result.covered[0].tagMatch, true);
  });

  it('matches scenario to correct test type with @integration tag', () => {
    const scenarios = [{ name: 'Data persists after save', tags: ['@integration'] }];
    const testFiles = [
      { path: 'src/__tests__/save.integration.test.js', content: 'test("Data persists after save", () => {})' },
    ];
    const result = validateTestCoverage(scenarios, testFiles);
    assert.equal(result.valid, true);
    assert.ok(result.covered.length > 0);
    assert.equal(result.covered[0].tagMatch, true);
  });

  it('rejects wrong test type for tag — @e2e scenario only in unit test file', () => {
    const scenarios = [
      { name: 'Request password reset email', tags: ['@e2e'], steps: [{ keyword: 'Given', text: 'x' }, { keyword: 'When', text: 'y' }, { keyword: 'Then', text: 'z' }] },
    ];
    const testFiles = [
      { path: 'src/__tests__/password-reset.test.js', content: 'test("Request password reset email", () => {})' },
    ];

    const result = validateTestCoverage(scenarios, testFiles);
    assert.equal(result.valid, false);
    assert.ok(result.mismatched.length > 0);
    assert.equal(result.mismatched[0].scenario, 'Request password reset email');
  });
});
