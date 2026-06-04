'use strict';

/**
 * Integration tests for `scripts/synapsys-lint.js` (GH-534).
 *
 * Task 3 scope (RED phase): scaffold binary + argv parsing + scope filtering.
 * Only the following Task-3 scenarios are exercised here:
 *   - "--scope=shared narrows discovery to the shared tier"  (AC-G8)
 *   - "Disabled and expired memories are skipped"            (AC-G9)
 *
 * Tasks 4–8 add the remaining scenarios.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, '..', 'scripts', 'synapsys-lint.js');
const FIXTURE_ROOT = path.join(__dirname, 'fixtures', 'store-overlap');
const PROJ_CWD = path.join(FIXTURE_ROOT, 'proj');
const FAKE_HOME = path.join(FIXTURE_ROOT, 'home');

function runLint(args, opts) {
  const env = Object.assign(
    {},
    process.env,
    { HOME: FAKE_HOME, NO_COLOR: '1' },
    (opts && opts.env) || {}
  );
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env,
  });
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (_) {
    return null;
  }
}

test('--scope=shared narrows discovery to the shared tier', () => {
  // With --scope=shared, the project tier overlap pair (mem-active-a vs mem-active-b)
  // must NOT be considered — only the shared-tier memory is visible.
  // At Task-3 scaffold stage `pairs` is empty regardless; we additionally assert
  // the JSON envelope shape and exit code 0.
  const r = runLint([`--cwd=${PROJ_CWD}`, '--scope=shared', '--json']);
  assert.equal(r.status, 0, `expected exit 0, got ${r.status}. stderr=${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.ok(env, `stdout was not parseable JSON:\n${r.stdout}`);
  for (const key of ['warnings', 'errors', 'pairs', 'broadTriggers']) {
    assert.ok(key in env, `envelope missing key '${key}': ${JSON.stringify(env)}`);
    assert.ok(Array.isArray(env[key]), `envelope.${key} must be an array`);
  }
  // Scaffold stage: pair arrays are empty (filled by Tasks 4–7).
  assert.equal(env.pairs.length, 0, 'scaffold-stage pairs must be empty');
  assert.equal(env.broadTriggers.length, 0, 'scaffold-stage broadTriggers must be empty');

  // Cross-check: --scope=project against the same fixture must observe the
  // project-tier memories (so the scope filter is actually distinguishing tiers).
  // We verify by asking for them via the programmatic `lintStore` entry point.
  const { lintStore } = require(CLI);
  const sharedResult = lintStore({ cwd: PROJ_CWD, scope: 'shared' });
  const projectResult = lintStore({ cwd: PROJ_CWD, scope: 'project' });
  assert.ok(
    sharedResult.memories.length < projectResult.memories.length,
    `scope=shared (${sharedResult.memories.length}) must see fewer memories than scope=project (${projectResult.memories.length})`
  );
  for (const m of sharedResult.memories) {
    assert.equal(m.store.kind, 'shared', `scope=shared yielded non-shared memory ${m.name}`);
  }
  for (const m of projectResult.memories) {
    assert.notEqual(m.store.kind, 'shared', `scope=project yielded shared memory ${m.name}`);
  }
});

test('Disabled and expired memories are skipped', () => {
  const { lintStore } = require(CLI);
  // scope=all so we capture project + shared.
  const result = lintStore({ cwd: PROJ_CWD, scope: 'all' });
  const names = result.memories.map((m) => m.name);
  assert.ok(names.includes('mem-active-a'), `active memory should be present, got ${names.join(',')}`);
  assert.ok(names.includes('mem-active-b'), `active memory should be present, got ${names.join(',')}`);
  assert.ok(!names.includes('mem-disabled'), `disabled memory must be skipped, got ${names.join(',')}`);
  assert.ok(!names.includes('mem-expired'), `expired memory must be skipped, got ${names.join(',')}`);
});

// ─── Task 4: trigger×trigger scoring + severity + domain/[[link]] downgrade ───

function findPair(pairs, aName, bName) {
  return pairs.find(
    (p) =>
      p.rule === 'trigger-overlap' &&
      ((p.a === aName && p.b === bName) || (p.a === bName && p.b === aName))
  );
}

test('Domain-shared pair is downgraded from high to low (AC-G2)', () => {
  const { lintStore } = require(CLI);
  const result = lintStore({ cwd: PROJ_CWD, scope: 'all' });
  const pair = findPair(result.pairs, 'mem-domain-a', 'mem-domain-b');
  assert.ok(pair, `expected trigger-overlap pair for mem-domain-a/mem-domain-b, got pairs=${JSON.stringify(result.pairs)}`);
  // Identical alternation tokens → jaccard = 1.0, would be `high` cross-domain.
  // Both share domain `release-ops` → severity capped at `low`.
  assert.equal(pair.severity, 'low', `domain-shared pair must be downgraded to low, got ${pair.severity}`);
  assert.ok(pair.intentional, 'pair must carry an `intentional` object');
  assert.equal(pair.intentional.domain, 'release-ops', `intentional.domain must equal shared domain, got ${pair.intentional.domain}`);
  assert.ok(typeof pair.score === 'number' && pair.score >= 0.5, `score should reflect raw jaccard (≥0.5), got ${pair.score}`);
});

test('[[wiki-link]] body reference downgrades severity (AC-G3)', () => {
  const { lintStore } = require(CLI);
  const result = lintStore({ cwd: PROJ_CWD, scope: 'all' });
  const pair = findPair(result.pairs, 'mem-link-a', 'mem-link-b');
  assert.ok(pair, `expected trigger-overlap pair for mem-link-a/mem-link-b, got pairs=${JSON.stringify(result.pairs)}`);
  // High raw overlap (jaccard 1.0) but mem-link-a.body references [[mem-link-b]]
  // → severity capped at `low`.
  assert.ok(
    pair.severity === 'low' || pair.severity === 'medium',
    `[[link]]-referenced pair must be at most low/medium, got ${pair.severity}`
  );
  assert.notEqual(pair.severity, 'high', '[[link]] downgrade must prevent `high` severity');
  assert.equal(pair.intentional && pair.intentional.link, true, `intentional.link must be true, got ${pair.intentional && pair.intentional.link}`);
});

// ─── Task 5: trigger×body match-density (slack/flake case study) ───

const SLACK_FIXTURE = path.join(FIXTURE_ROOT, 'slack-handoff-ask-before-clipboard.md');
const FLAKE_FIXTURE = path.join(FIXTURE_ROOT, 'flaky-test-fix-protocol.md');

function buildSlackFlakeStore() {
  // The Task-5 fixtures live at the fixture-root for spec traceability
  // (tasks.md §Files-in-scope). They are copied into a per-test temp store
  // so the existing `proj` fixtures (used by Task-3/4 tests above) are
  // not perturbed by extra memories that would generate cross-pairs.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-lint-task5-'));
  const storeDir = path.join(root, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), '{"version":1,"kind":"project"}\n');
  fs.copyFileSync(SLACK_FIXTURE, path.join(storeDir, path.basename(SLACK_FIXTURE)));
  fs.copyFileSync(FLAKE_FIXTURE, path.join(storeDir, path.basename(FLAKE_FIXTURE)));
  // Isolated HOME so global/shared discovery does not leak in real memories.
  const isolatedHome = path.join(root, 'home');
  fs.mkdirSync(isolatedHome, { recursive: true });
  return { cwd: root, home: isolatedHome };
}

test('Trigger×body match flags the slack/flake case study as high (AC-G1)', () => {
  const { cwd, home } = buildSlackFlakeStore();
  // Programmatic API: lintStore must surface a high-severity
  // trigger-body-overlap pair between the two case-study memories.
  const { lintStore } = require(CLI);
  const result = lintStore({ cwd, scope: 'all' });
  const bodyPair = result.pairs.find(
    (p) =>
      p.rule === 'trigger-body-overlap' &&
      [p.a, p.b].sort().join('|') ===
        ['flaky-test-fix-protocol', 'slack-handoff-ask-before-clipboard'].join('|')
  );
  assert.ok(
    bodyPair,
    `expected trigger-body-overlap pair for slack/flake case study, got pairs=${JSON.stringify(result.pairs)}`
  );
  assert.equal(bodyPair.severity, 'high', `slack/flake body pair must be high, got ${bodyPair.severity}`);
  assert.ok(typeof bodyPair.score === 'number' && bodyPair.score >= 4, `score (matchCount) must be ≥4, got ${bodyPair.score}`);
  assert.ok(
    Array.isArray(bodyPair.matchedTokens) && bodyPair.matchedTokens.includes('slack'),
    `matchedTokens must include the literal 'slack' token, got ${JSON.stringify(bodyPair.matchedTokens)}`
  );

  // CLI exit code: AC-G1 requires `exit 1` when the case study is present.
  const r = runLint([`--cwd=${cwd}`, '--scope=all', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 1, `expected exit 1 for slack/flake high pair, got ${r.status}. stderr=${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.ok(env, `stdout was not parseable JSON:\n${r.stdout}`);
  const cliPair = env.pairs.find((p) => p.rule === 'trigger-body-overlap');
  assert.ok(cliPair, `CLI JSON envelope must include a trigger-body-overlap pair, got pairs=${JSON.stringify(env.pairs)}`);
  assert.equal(cliPair.severity, 'high', `CLI pair severity must be high, got ${cliPair.severity}`);
});

test('Exit code is non-zero only when at least one high-severity pair exists (AC-G7)', () => {
  // With --overlap-threshold=0.99, no pair should reach the `high` cutoff
  // → no high pairs → exit code 0, but pairs are still listed.
  const rHi = runLint([`--cwd=${PROJ_CWD}`, '--scope=all', '--json', '--overlap-threshold=0.99']);
  assert.equal(rHi.status, 0, `expected exit 0 when no high pairs, got ${rHi.status}. stderr=${rHi.stderr}`);
  const envHi = parseJson(rHi.stdout);
  assert.ok(envHi, 'JSON envelope must parse');
  // With overlap downgrades applied + raised threshold, no pair has severity:'high'.
  const highPairsHi = envHi.pairs.filter((p) => p.severity === 'high');
  assert.equal(highPairsHi.length, 0, `expected zero high pairs at threshold 0.99, got ${JSON.stringify(highPairsHi)}`);

  // With the default threshold (0.50), mem-active-a / mem-active-b form a
  // jaccard=0.5 cross-domain (no shared domain) high pair → exit 1.
  const rLo = runLint([`--cwd=${PROJ_CWD}`, '--scope=all', '--json']);
  const envLo = parseJson(rLo.stdout);
  assert.ok(envLo, `JSON envelope must parse, stdout=${rLo.stdout}`);
  const activePair = findPair(envLo.pairs, 'mem-active-a', 'mem-active-b');
  assert.ok(activePair, `expected mem-active-a/mem-active-b pair under default threshold, got ${JSON.stringify(envLo.pairs)}`);
  assert.equal(activePair.severity, 'high', `cross-domain jaccard≥0.5 pair must be high, got ${activePair.severity}`);
  assert.equal(rLo.status, 1, `expected exit 1 when at least one high pair exists, got ${rLo.status}. stderr=${rLo.stderr}`);
});
