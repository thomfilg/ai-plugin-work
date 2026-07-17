'use strict';

/**
 * outcome-verdicts.test.js — pins the shared flag vocabulary contract
 * (GH-769 Task 2: `cross-task-attribution` flag kind).
 *
 * Every flag consumer (verdict engine, corpus validator, outcome gate,
 * check flag gate) reads FLAG_KINDS / FLAG_KIND_VALUES from this one
 * module, so the vocabulary itself must be pinned by test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { FLAG_KINDS, FLAG_KIND_VALUES } = require('../outcome-verdicts');

/** Pre-existing flag entries that must never change or disappear. */
const PRE_EXISTING_FLAG_KINDS = Object.freeze({
  noStructuredReporter: 'no-structured-reporter',
  baseSetupFailed: 'base-setup-failed',
  coverageUnavailable: 'coverage-unavailable',
  coverageBelowThreshold: 'coverage-below-threshold',
  tautology: 'tautology',
  runnerUnknown: 'runner-unknown',
  scopeResolutionFailed: 'scope-resolution-failed',
  noTestFilesInDiff: 'no-test-files-in-diff',
});

test('FLAG_KINDS exposes crossTaskAttribution as "cross-task-attribution"', () => {
  assert.equal(FLAG_KINDS.crossTaskAttribution, 'cross-task-attribution');
});

test('FLAG_KIND_VALUES contains "cross-task-attribution" exactly once', () => {
  const occurrences = FLAG_KIND_VALUES.filter((value) => value === 'cross-task-attribution');
  assert.equal(occurrences.length, 1);
});

test('FLAG_KINDS and FLAG_KIND_VALUES remain frozen', () => {
  assert.equal(Object.isFrozen(FLAG_KINDS), true);
  assert.equal(Object.isFrozen(FLAG_KIND_VALUES), true);
});

test('every pre-existing flag value is still present and unchanged', () => {
  for (const [key, value] of Object.entries(PRE_EXISTING_FLAG_KINDS)) {
    assert.equal(FLAG_KINDS[key], value);
    assert.ok(FLAG_KIND_VALUES.includes(value));
  }
});

test('FLAG_KIND_VALUES stays derived from FLAG_KINDS (no extras, no drift)', () => {
  assert.deepEqual(FLAG_KIND_VALUES, Object.values(FLAG_KINDS));
});
