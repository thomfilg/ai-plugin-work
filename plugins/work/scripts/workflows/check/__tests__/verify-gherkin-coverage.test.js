/**
 * Tests for the GH-274 static Gherkin-to-test coverage verifier:
 * keyword extraction, test-description extraction, manual overrides,
 * pure matching + rendering, and the full pipeline against a real temp
 * git repo (missing-spec / zero-scenario silent skips included).
 */

'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const {
  extractKeywords,
  extractTestDescriptions,
  parseCoverageOverrides,
  findKeywordMatch,
  verifyCoverage,
  renderCoverage,
  runGherkinCoverageCheck,
} = require('../lib/verify-gherkin-coverage');

// ─── extractKeywords ────────────────────────────────────────────────────────

describe('extractKeywords', () => {
  it('drops stop words and keeps significant tokens lowercased', () => {
    assert.deepEqual(extractKeywords('The user can reset a password'), [
      'user',
      'reset',
      'password',
    ]);
  });

  it('caps at 3 keywords, keeping the longest in original order', () => {
    const kw = extractKeywords('admin exports the quarterly revenue report as csv');
    assert.equal(kw.length, 3);
    // longest tokens win: quarterly(9), exports(7), revenue(7) — original order kept
    assert.deepEqual(kw, ['exports', 'quarterly', 'revenue']);
  });

  it('dedupes repeated tokens', () => {
    assert.deepEqual(extractKeywords('retry retry retry upload'), ['retry', 'upload']);
  });

  it('returns [] for an all-stop-word or empty name', () => {
    assert.deepEqual(extractKeywords('it should be as it was'), []);
    assert.deepEqual(extractKeywords(''), []);
    assert.deepEqual(extractKeywords(null), []);
  });

  it('splits on punctuation and drops 1-char noise', () => {
    assert.deepEqual(extractKeywords('re-runs /check! (v 2)'), ['re', 'runs', 'check']);
  });
});

// ─── extractTestDescriptions ────────────────────────────────────────────────

describe('extractTestDescriptions', () => {
  const SRC = [
    "describe('widget suite', () => {", // line 1
    "  it('renders the widget', () => {});", // line 2
    '  test("computes the total", () => {});', // line 3
    '  it.only(`handles ${x} edge`, () => {});', // line 4 (template literal)
    "  it.each([[1], [2]])('parametrized case', () => {});", // line 5
    "  notAtest('ignored call');", // line 6
    '});',
  ].join('\n');

  it("extracts it('...')/test('...')/describe('...') with 1-based line numbers", () => {
    const out = extractTestDescriptions(SRC);
    assert.deepEqual(
      out.map((d) => [d.description, d.line]),
      [
        ['widget suite', 1],
        ['renders the widget', 2],
        ['computes the total', 3],
        ['handles ${x} edge', 4],
        ['parametrized case', 5],
      ]
    );
  });

  it('handles escaped quotes inside descriptions', () => {
    const out = extractTestDescriptions("it('user\\'s data persists', fn)");
    assert.equal(out.length, 1);
    assert.match(out[0].description, /data persists/);
  });

  it('returns [] for empty / non-string input', () => {
    assert.deepEqual(extractTestDescriptions(''), []);
    assert.deepEqual(extractTestDescriptions(null), []);
  });
});

// ─── parseCoverageOverrides ─────────────────────────────────────────────────

describe('parseCoverageOverrides', () => {
  it('parses unicode-arrow annotations with file:line', () => {
    const o = parseCoverageOverrides(
      '<!-- gherkin-covered: legacy import works → tests/import.test.js:42 -->'
    );
    assert.deepEqual(o.get('legacy import works'), { file: 'tests/import.test.js', line: 42 });
  });

  it('accepts a plain -> arrow and a file without :line', () => {
    const o = parseCoverageOverrides('<!-- gherkin-covered: odd name -> a/b.test.js -->');
    assert.deepEqual(o.get('odd name'), { file: 'a/b.test.js', line: null });
  });

  it('collects multiple annotations, keyed case-insensitively', () => {
    const o = parseCoverageOverrides(
      [
        '<!-- gherkin-covered: First Case → x.test.js:1 -->',
        '<!-- gherkin-covered: second case → y.test.js:2 -->',
      ].join('\n')
    );
    assert.equal(o.size, 2);
    assert.ok(o.has('first case'));
    assert.ok(o.has('second case'));
  });

  it('returns an empty map for specs without annotations', () => {
    assert.equal(parseCoverageOverrides('# spec\nno annotations').size, 0);
    assert.equal(parseCoverageOverrides(null).size, 0);
  });
});

// ─── matching + rendering (pure) ────────────────────────────────────────────

const DESCRIPTIONS = [
  { file: 'auth.test.js', description: 'login succeeds with valid credentials', line: 12 },
  { file: 'auth.test.js', description: 'login fails with a bad password', line: 30 },
];

describe('findKeywordMatch / verifyCoverage', () => {
  it('requires ALL keywords within a single description (case-insensitive)', () => {
    assert.deepEqual(findKeywordMatch(['credentials', 'succeeds', 'login'], DESCRIPTIONS), {
      file: 'auth.test.js',
      line: 12,
    });
    // 'credentials' + 'fails' are split across two descriptions → no match.
    assert.equal(findKeywordMatch(['credentials', 'fails'], DESCRIPTIONS), null);
  });

  it('never matches on an empty keyword list', () => {
    assert.equal(findKeywordMatch([], DESCRIPTIONS), null);
  });

  it('marks scenarios covered / uncovered and counts them', () => {
    const cov = verifyCoverage({
      scenarios: [
        { name: 'User login succeeds with valid CREDENTIALS' },
        { name: 'password reset email is dispatched' },
      ],
      descriptions: DESCRIPTIONS,
    });
    assert.equal(cov.total, 2);
    assert.equal(cov.coveredCount, 1);
    assert.equal(cov.uncoveredCount, 1);
    const [hit, miss] = cov.results;
    assert.deepEqual(
      { covered: hit.covered, file: hit.file, line: hit.line, via: hit.via },
      { covered: true, file: 'auth.test.js', line: 12, via: 'match' }
    );
    assert.equal(miss.covered, false);
    assert.equal(miss.via, null);
  });

  it('manual override marks an otherwise-unmatched scenario covered', () => {
    const cov = verifyCoverage({
      scenarios: [{ name: 'weird legacy behavior' }],
      descriptions: [],
      overrides: new Map([['weird legacy behavior', { file: 'legacy.test.js', line: 7 }]]),
    });
    assert.equal(cov.coveredCount, 1);
    assert.equal(cov.results[0].via, 'override');
    assert.equal(cov.results[0].file, 'legacy.test.js');
  });
});

describe('renderCoverage — issue output shape', () => {
  it('renders the N/M header, per-scenario lines, and the missing count', () => {
    const lines = renderCoverage(
      verifyCoverage({
        scenarios: [
          { name: 'login succeeds with valid credentials' },
          { name: 'password reset email is dispatched' },
        ],
        descriptions: DESCRIPTIONS,
      })
    );
    assert.equal(lines[0], 'Gherkin Coverage: 1/2 scenarios covered');
    assert.match(lines[1], /^✅ login succeeds with valid credentials → auth\.test\.js:12$/);
    assert.match(lines[2], /^❌ password reset email is dispatched → NO MATCH FOUND$/);
    assert.equal(lines[3], '1 scenarios missing test coverage.');
  });

  it('omits the missing-count line when everything is covered', () => {
    const lines = renderCoverage(
      verifyCoverage({
        scenarios: [{ name: 'login succeeds with valid credentials' }],
        descriptions: DESCRIPTIONS,
      })
    );
    assert.equal(lines[0], 'Gherkin Coverage: 1/1 scenarios covered');
    assert.equal(lines.length, 2);
  });
});

// ─── Full pipeline against a real temp git repo ─────────────────────────────

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function sh(cmd, cwd) {
  return execSync(cmd, { cwd, encoding: 'utf8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
}

function write(base, rel, content) {
  const p = path.join(base, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

const COVERAGE_SPEC = [
  '# Spec',
  '',
  '## Test Scenarios (Gherkin)',
  '',
  'Feature: Auth',
  '',
  '  @unit',
  '  Scenario: login succeeds with valid credentials',
  '    Given a user',
  '    Then login succeeds',
  '',
  '  @unit',
  '  Scenario: password reset email is dispatched',
  '    Given a user',
  '    Then an email goes out',
  '',
].join('\n');

describe('runGherkinCoverageCheck — real repo pipeline', () => {
  let repo;
  let savedBase;

  before(() => {
    savedBase = process.env.BASE_BRANCH;
    process.env.BASE_BRANCH = 'main';
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gherkin-cov-repo-'));
    sh('git init -q -b main', repo);
    write(repo, 'README.md', 'hi\n');
    sh('git add -A && git commit -q -m base', repo);
    sh('git update-ref refs/remotes/origin/main HEAD', repo);
    sh('git checkout -q -b feature', repo);
    write(
      repo,
      '__tests__/auth.test.js',
      [
        "describe('auth', () => {",
        "  it('login succeeds with valid credentials', () => {});",
        '});',
        '',
      ].join('\n')
    );
    write(repo, 'src/auth.js', 'module.exports = 1;\n'); // non-test file in diff
    sh('git add -A && git commit -q -m tests', repo);
  });

  after(() => {
    if (savedBase === undefined) delete process.env.BASE_BRANCH;
    else process.env.BASE_BRANCH = savedBase;
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('matches spec scenarios against the diff test files (non-tests ignored)', () => {
    const r = runGherkinCoverageCheck({ specText: COVERAGE_SPEC, cwd: repo });
    assert.equal(r.skipped, false);
    assert.equal(r.total, 2);
    assert.equal(r.coveredCount, 1);
    assert.equal(r.testFileCount, 1, 'src/auth.js must not be scanned');
    const hit = r.results.find((x) => x.covered);
    assert.equal(hit.file, '__tests__/auth.test.js');
    assert.equal(hit.line, 2);
    assert.deepEqual(r.results.find((x) => !x.covered).name, 'password reset email is dispatched');
  });

  it('an override annotation in spec.md covers the unmatched scenario', () => {
    const spec =
      COVERAGE_SPEC +
      '\n<!-- gherkin-covered: password reset email is dispatched → mailer.test.js:9 -->\n';
    const r = runGherkinCoverageCheck({ specText: spec, cwd: repo });
    assert.equal(r.uncoveredCount, 0);
    const override = r.results.find((x) => x.via === 'override');
    assert.deepEqual(
      { file: override.file, line: override.line },
      { file: 'mailer.test.js', line: 9 }
    );
  });

  it('skips silently when spec.md is missing/empty', () => {
    assert.equal(runGherkinCoverageCheck({ specText: null, cwd: repo }).skipped, true);
    assert.equal(runGherkinCoverageCheck({ specText: '  \n', cwd: repo }).skipped, true);
  });

  it('skips silently when the spec has zero Gherkin scenarios', () => {
    const r = runGherkinCoverageCheck({ specText: '# Spec\n\nJust prose.\n', cwd: repo });
    assert.equal(r.skipped, true);
    assert.match(r.reason, /no Gherkin scenarios/);
  });
});
