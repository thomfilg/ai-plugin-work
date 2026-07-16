'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadCorpus, validateFixture, FIXTURES_DIR } = require('..');
const { VERDICTS } = require('../../outcome-verdicts');

/**
 * Incidents the plan (§6 Phase 0) requires the corpus to cover. GH-539 is
 * covered via its planner-defect framing; GH-720 via cross-task attribution.
 */
const REQUIRED_INCIDENTS = [
  'GH-749',
  'GH-737',
  'GH-736',
  'GH-727',
  'GH-725',
  'GH-724',
  'GH-722',
  'GH-721',
  'GH-720',
  'GH-694',
  'GH-693',
  'GH-653',
  'GH-606',
  'GH-584',
  'GH-532',
  'GH-509',
  'GH-466',
  'GH-462',
  'GH-248',
  'GH-539',
];

function validFixture(overrides = {}) {
  return {
    name: 'test-fixture',
    incident: 'GH-999',
    incidentClass: 1,
    taskKind: 'tdd-code',
    description: 'synthetic fixture for validator tests',
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

describe('replay-corpus — fixture validation', () => {
  it('accepts a fully-formed fixture', () => {
    assert.deepEqual(validateFixture(validFixture()), []);
  });

  it('rejects non-object input', () => {
    assert.ok(validateFixture(null).length > 0);
    assert.ok(validateFixture([]).length > 0);
  });

  it('requires a typed exit and violated invariants for CONTRADICTED', () => {
    const missingBoth = validFixture({
      expected: { verdict: 'CONTRADICTED', rationale: 'r' },
    });
    const errors = validateFixture(missingBoth);
    assert.ok(errors.some((e) => e.includes('expected.exit')));
    assert.ok(errors.some((e) => e.includes('violatedInvariants')));

    const complete = validFixture({
      expected: {
        verdict: 'CONTRADICTED',
        exit: 'retry',
        violatedInvariants: ['I4'],
        rationale: 'r',
      },
    });
    assert.deepEqual(validateFixture(complete), []);
  });

  it('requires flags for UNVERIFIED and forbids exit outside CONTRADICTED', () => {
    const noFlags = validFixture({ expected: { verdict: 'UNVERIFIED', rationale: 'r' } });
    assert.ok(validateFixture(noFlags).some((e) => e.includes('expected.flags')));

    const strayExit = validFixture({
      expected: { verdict: 'VERIFIED', exit: 'retry', rationale: 'r' },
    });
    assert.ok(validateFixture(strayExit).some((e) => e.includes('only legal for CONTRADICTED')));
  });

  it('rejects unknown kinds, verdicts, outcomes, and malformed incidents', () => {
    assert.ok(validateFixture(validFixture({ taskKind: 'nope' })).length > 0);
    assert.ok(
      validateFixture(validFixture({ expected: { verdict: 'MAYBE', rationale: 'r' } })).length > 0
    );
    assert.ok(validateFixture(validFixture({ incident: '749' })).length > 0);
    const badRun = validFixture();
    badRun.observations.headRun.outcome = 'sideways';
    assert.ok(validateFixture(badRun).length > 0);
  });
});

describe('replay-corpus — loadCorpus over a directory', () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-corpus-test-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reports unparseable JSON and name/filename mismatches', () => {
    fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
    fs.writeFileSync(
      path.join(dir, 'misnamed.json'),
      JSON.stringify(validFixture({ name: 'other-name' }))
    );
    const { errors } = loadCorpus({ fixturesDir: dir });
    assert.ok(errors.some((e) => e.startsWith('broken.json: unparseable JSON')));
    assert.ok(errors.some((e) => e.includes('must equal filename stem')));
  });

  it('reports duplicate fixture names across files', () => {
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify(validFixture({ name: 'a' })));
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify(validFixture({ name: 'a' })));
    const { errors } = loadCorpus({ fixturesDir: dir });
    assert.ok(errors.some((e) => e.includes('must equal filename stem')));
    assert.ok(errors.some((e) => e.includes('duplicate fixture name: a')));
  });

  it('returns a dir-level error for a missing directory', () => {
    const { fixtures, errors } = loadCorpus({ fixturesDir: path.join(dir, 'absent') });
    assert.equal(fixtures.length, 0);
    assert.equal(errors.length, 1);
  });
});

describe('replay-corpus — the shipped corpus', () => {
  const { fixtures, errors } = loadCorpus();

  it('loads with zero validation errors', () => {
    assert.deepEqual(errors, []);
  });

  it('covers every incident the plan requires', () => {
    const covered = new Set(fixtures.map((f) => f.incident));
    const missing = REQUIRED_INCIDENTS.filter((i) => !covered.has(i));
    assert.deepEqual(missing, [], `corpus missing incidents: ${missing.join(', ')}`);
  });

  it('labels every historical wedge as advancing (never a dead-end block)', () => {
    // Classes 2 (permanent wedges): the outcome verifier must never reproduce
    // the dead end — CONTRADICTED is allowed only with a recoverable exit.
    for (const f of fixtures.filter((x) => x.incidentClass === 2)) {
      if (f.expected.verdict === VERDICTS.contradicted) {
        assert.ok(
          f.expected.exit,
          `${f.name}: wedge-class CONTRADICTED fixture must carry a typed exit`
        );
      }
    }
  });

  it('keeps fixtures dir and loader defaults in sync', () => {
    assert.ok(fs.existsSync(FIXTURES_DIR));
    assert.ok(fixtures.length >= 18, `expected >= 18 fixtures, got ${fixtures.length}`);
  });
});
