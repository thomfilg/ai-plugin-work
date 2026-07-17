'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { loadCorpus, validateFixture } = require('..');
const { FLAG_KIND_VALUES } = require('../../outcome-verdicts');

/** A minimal fully-valid fixture (mirrors replay-corpus.test.js). */
function validFixture(overrides = {}) {
  return {
    name: 'test-fixture',
    incident: 'GH-999',
    incidentClass: 7,
    taskKind: 'tdd-code',
    description: 'synthetic fixture for attribution validator tests',
    observations: {
      diff: { empty: false, filesChanged: ['src/a.js'], scopeGlobs: ['src/**'], outOfScope: [] },
      deliverables: { promised: ['src/a.js'], missing: [] },
      baseRun: { attempted: true, supported: true, outcome: 'fail', testsRan: 2, failures: 2 },
      headRun: {
        attempted: true,
        supported: true,
        outcome: 'pass',
        testsRan: 2,
        failures: 0,
        exitCode: 0,
        reporterKind: 'structured',
      },
      coverage: { supported: true, changedLineCoveragePct: 92 },
    },
    expected: { verdict: 'VERIFIED', rationale: 'all invariants hold' },
    provenance: { issue: 'https://github.com/thomfilg/ai-plugin-work/issues/999' },
    ...overrides,
  };
}

/** A well-formed optional attribution block. */
function validAttribution(overrides = {}) {
  return {
    supported: true,
    mode: 'trailer',
    taskId: 4,
    foreignTasks: ['1'],
    unattributedCount: 0,
    ...overrides,
  };
}

/** Build a fixture carrying an attribution block with the given overrides. */
function fixtureWithAttribution(attributionOverrides = {}) {
  const fixture = validFixture();
  fixture.observations.attribution = validAttribution(attributionOverrides);
  return fixture;
}

describe('replay-corpus — optional observations.attribution validation', () => {
  it('accepts a fixture with a well-formed attribution block', () => {
    assert.deepEqual(validateFixture(fixtureWithAttribution()), []);
  });

  it('still validates a fixture WITHOUT the attribution block', () => {
    assert.deepEqual(validateFixture(validFixture()), []);
  });

  it("rejects mode 'branch' (must be trailer|none)", () => {
    const errors = validateFixture(fixtureWithAttribution({ mode: 'branch' }));
    assert.ok(
      errors.some((e) => e.includes('observations.attribution.mode')),
      `expected an observations.attribution.mode error, got: ${JSON.stringify(errors)}`
    );
  });

  it("accepts mode 'none'", () => {
    assert.deepEqual(validateFixture(fixtureWithAttribution({ mode: 'none' })), []);
  });

  it("rejects supported 'yes' (boolean required)", () => {
    const errors = validateFixture(fixtureWithAttribution({ supported: 'yes' }));
    assert.ok(
      errors.some((e) => e.includes('observations.attribution.supported')),
      `expected an observations.attribution.supported error, got: ${JSON.stringify(errors)}`
    );
  });

  it("rejects taskId 'four' (integer or null required)", () => {
    const errors = validateFixture(fixtureWithAttribution({ taskId: 'four' }));
    assert.ok(
      errors.some((e) => e.includes('observations.attribution.taskId')),
      `expected an observations.attribution.taskId error, got: ${JSON.stringify(errors)}`
    );
  });

  it('accepts taskId null', () => {
    assert.deepEqual(validateFixture(fixtureWithAttribution({ taskId: null })), []);
  });

  it("rejects foreignTasks '1' (string array required)", () => {
    const errors = validateFixture(fixtureWithAttribution({ foreignTasks: '1' }));
    assert.ok(
      errors.some((e) => e.includes('observations.attribution.foreignTasks')),
      `expected an observations.attribution.foreignTasks error, got: ${JSON.stringify(errors)}`
    );
  });

  it('rejects unattributedCount -1 (integer >= 0 required)', () => {
    const errors = validateFixture(fixtureWithAttribution({ unattributedCount: -1 }));
    assert.ok(
      errors.some((e) => e.includes('observations.attribution.unattributedCount')),
      `expected an observations.attribution.unattributedCount error, got: ${JSON.stringify(errors)}`
    );
  });

  it("accepts the expected flag 'cross-task-attribution' in flag-value validation", () => {
    assert.ok(FLAG_KIND_VALUES.includes('cross-task-attribution'));
    const fixture = fixtureWithAttribution();
    fixture.expected = {
      verdict: 'UNVERIFIED',
      flags: ['cross-task-attribution'],
      rationale: 'evidence overlaps a sibling task',
    };
    assert.deepEqual(validateFixture(fixture), []);
  });
});

describe('replay-corpus — corpus regression with attribution support', () => {
  it('Replay corpus stays 100% green with the new fixture', () => {
    const { fixtures, errors } = loadCorpus();
    assert.deepEqual(errors, []);
    assert.ok(fixtures.length >= 22, `expected >= 22 fixtures, got ${fixtures.length}`);
  });
});
