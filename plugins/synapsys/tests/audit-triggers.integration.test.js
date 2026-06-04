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

// ─── Task 6: pretool×pretool within-tool arg-set intersection (AC-G5) ───

const PRETOOL_A_FIXTURE = path.join(FIXTURE_ROOT, 'pretool-a.md');
const PRETOOL_B_FIXTURE = path.join(FIXTURE_ROOT, 'pretool-b.md');

function buildPretoolOverlapStore() {
  // Per-test isolated store so the existing `proj` fixtures (Task 3/4)
  // do not pollute pair generation with unrelated overlaps.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-lint-task6-'));
  const storeDir = path.join(root, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), '{"version":1,"kind":"project"}\n');
  fs.copyFileSync(PRETOOL_A_FIXTURE, path.join(storeDir, path.basename(PRETOOL_A_FIXTURE)));
  fs.copyFileSync(PRETOOL_B_FIXTURE, path.join(storeDir, path.basename(PRETOOL_B_FIXTURE)));
  const isolatedHome = path.join(root, 'home');
  fs.mkdirSync(isolatedHome, { recursive: true });
  return { cwd: root, home: isolatedHome };
}

test('Pretool×pretool intersection within a tool surfaces as a pair (AC-G5)', () => {
  const { cwd } = buildPretoolOverlapStore();
  const { lintStore } = require(CLI);
  const result = lintStore({ cwd, scope: 'all' });
  const pretoolPair = result.pairs.find(
    (p) =>
      p.rule === 'pretool-overlap' &&
      [p.a, p.b].sort().join('|') === ['pretool-a', 'pretool-b'].join('|')
  );
  assert.ok(
    pretoolPair,
    `expected pretool-overlap pair for pretool-a/pretool-b, got pairs=${JSON.stringify(result.pairs)}`
  );
  assert.equal(pretoolPair.tool, 'Bash', `pair must carry tool field 'Bash', got ${pretoolPair.tool}`);
  // A's arg-regex set is a strict subset of B's (A: {gh\s+pr\s+view},
  // B: {gh\s+pr\s+(view|checkout)} — A ⊂ B) → severity must be `high`
  // per spec §Architecture (equal/strict-subset → high). At minimum it
  // must be medium (AC-G5: "severity ≥ medium").
  assert.ok(
    pretoolPair.severity === 'high' || pretoolPair.severity === 'medium',
    `pretool-overlap severity must be at least medium, got ${pretoolPair.severity}`
  );
  assert.notEqual(pretoolPair.severity, 'low', 'pretool-overlap with strict-subset must not be low');
  assert.ok(typeof pretoolPair.score === 'number', `pair.score must be a number, got ${typeof pretoolPair.score}`);
});

// ─── Task 7: too-broad-trigger per-memory rule (AC-G4) ───

const TOO_BROAD_CI_FIXTURE = path.join(FIXTURE_ROOT, 'too-broad-ci.md');

function buildTooBroadStore() {
  // Per-test isolated store so the broad-trigger fixture does not
  // interfere with the `proj` fixtures used by Task 3/4 tests.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-lint-task7-'));
  const storeDir = path.join(root, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), '{"version":1,"kind":"project"}\n');
  fs.copyFileSync(TOO_BROAD_CI_FIXTURE, path.join(storeDir, path.basename(TOO_BROAD_CI_FIXTURE)));
  const isolatedHome = path.join(root, 'home');
  fs.mkdirSync(isolatedHome, { recursive: true });
  return { cwd: root, home: isolatedHome };
}

test('too-broad-trigger rule flags a trivially short trigger (AC-G4)', () => {
  const { cwd, home } = buildTooBroadStore();
  const { lintStore } = require(CLI);
  const result = lintStore({ cwd, scope: 'all' });

  // The broad-trigger memory must NOT appear in `pairs` (R7: distinct rule, not pairwise).
  const broadInPairs = result.pairs.find(
    (p) => p.a === 'too-broad-ci' || p.b === 'too-broad-ci'
  );
  assert.equal(
    broadInPairs,
    undefined,
    `too-broad-trigger memory must not be reported as a pair, got pair=${JSON.stringify(broadInPairs)}`
  );

  // The broad-trigger memory must appear in `broadTriggers` envelope key.
  assert.ok(
    Array.isArray(result.broadTriggers),
    `broadTriggers must be an array, got ${typeof result.broadTriggers}`
  );
  const entry = result.broadTriggers.find((e) => e.name === 'too-broad-ci');
  assert.ok(
    entry,
    `expected broadTriggers entry for too-broad-ci, got broadTriggers=${JSON.stringify(result.broadTriggers)}`
  );
  assert.equal(entry.rule, 'too-broad-trigger', `rule field must be 'too-broad-trigger', got ${entry.rule}`);
  assert.equal(entry.severity, 'medium', `severity must be 'medium', got ${entry.severity}`);
  assert.ok(
    typeof entry.reason === 'string' && entry.reason.length > 0,
    `entry.reason must be a non-empty string, got ${JSON.stringify(entry.reason)}`
  );

  // Exit code is unaffected (medium, never high).
  const r = runLint([`--cwd=${cwd}`, '--scope=all', '--json'], { env: { HOME: home } });
  assert.equal(r.status, 0, `expected exit 0 (broad-trigger is medium, never high), got ${r.status}. stderr=${r.stderr}`);
  const env = parseJson(r.stdout);
  assert.ok(env, `stdout was not parseable JSON:\n${r.stdout}`);
  const cliEntry = env.broadTriggers.find((e) => e.name === 'too-broad-ci');
  assert.ok(
    cliEntry,
    `CLI JSON envelope must include too-broad-ci in broadTriggers, got broadTriggers=${JSON.stringify(env.broadTriggers)}`
  );
  assert.equal(cliEntry.severity, 'medium', `CLI broad entry severity must be 'medium', got ${cliEntry.severity}`);
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

// ─── Task 8: suggestion generator + formatHuman/formatJson ordering ───
//
// Three scenarios per tasks.md §Task 8 §Sub-deliverables 8.1.1 RED:
//   (a) suggestion strings contain a token literal from the pair,
//   (b) pairs ordered severity desc then score desc,
//   (c) human output renders pair header, cause, suggestion, overlap rate +
//       severity tag in that order.

test('Task 8 (a) — suggestion strings reference a concrete token from the pair (AC-G1 / R8)', () => {
  const { cwd } = buildSlackFlakeStore();
  const { lintStore } = require(CLI);
  const result = lintStore({ cwd, scope: 'all' });

  // Every reported trigger-overlap / trigger-body-overlap pair MUST carry a
  // non-empty suggestion string. (Task 7's `broadTriggers` entries are NOT
  // pairs and are excluded from this assertion.)
  assert.ok(result.pairs.length > 0, 'fixture must produce at least one pair');
  for (const p of result.pairs) {
    assert.equal(
      typeof p.suggestion,
      'string',
      `pair ${p.a}/${p.b} (${p.rule}) suggestion must be a string, got ${typeof p.suggestion}`
    );
    assert.ok(
      p.suggestion.length > 0,
      `pair ${p.a}/${p.b} (${p.rule}) suggestion must be non-empty`
    );
  }

  // The slack/flake body pair must mention a literal token that appears in
  // either memory's trigger or body — not a generic recommendation.
  const slackFlake = result.pairs.find(
    (p) =>
      p.rule === 'trigger-body-overlap' &&
      [p.a, p.b].sort().join('|') ===
        ['flaky-test-fix-protocol', 'slack-handoff-ask-before-clipboard'].join('|')
  );
  assert.ok(slackFlake, `slack/flake body pair must exist, got pairs=${JSON.stringify(result.pairs.map((p) => [p.rule, p.a, p.b]))}`);
  const concreteTokens = ['slack', 'clipboard', 'handoff', 'flaky', 'flake', 'intermittent', 'quarantine'];
  const lowered = slackFlake.suggestion.toLowerCase();
  assert.ok(
    concreteTokens.some((t) => lowered.includes(t)),
    `suggestion must name a concrete token from {${concreteTokens.join(', ')}}, got "${slackFlake.suggestion}"`
  );
  // R8: a generic phrase like "tighten your trigger" is not acceptable.
  assert.ok(
    !/^(tighten|review|fix|consider)\b[^`]*$/i.test(slackFlake.suggestion.trim()) ||
      concreteTokens.some((t) => lowered.includes(t)),
    `suggestion must not be generic advice without a token literal, got "${slackFlake.suggestion}"`
  );
});

test('Task 8 (b) — pairs are ordered severity desc then score desc (R9)', () => {
  // Build a mixed fixture by composing the existing per-task stores so we
  // get pairs across severities (high / medium / low). We invoke `lintStore`
  // directly on each, then assert the comparator on the slack/flake store
  // (which produces multiple body pairs) and on the trigger-overlap proj
  // fixture (which carries low/medium/high mixes from Task-4 downgrades).
  const { lintStore } = require(CLI);

  const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };
  function assertOrdered(pairs, label) {
    for (let i = 1; i < pairs.length; i++) {
      const prev = pairs[i - 1];
      const cur = pairs[i];
      const prevRank = SEVERITY_RANK[prev.severity];
      const curRank = SEVERITY_RANK[cur.severity];
      assert.ok(
        prevRank >= curRank,
        `${label}: pairs[${i - 1}].severity (${prev.severity}) must be >= pairs[${i}].severity (${cur.severity})`
      );
      if (prevRank === curRank) {
        assert.ok(
          prev.score >= cur.score,
          `${label}: same-severity pairs must be score-desc; pairs[${i - 1}].score=${prev.score} < pairs[${i}].score=${cur.score}`
        );
      }
    }
  }

  const projResult = lintStore({ cwd: PROJ_CWD, scope: 'all' });
  assert.ok(projResult.pairs.length >= 2, `proj fixture must produce ≥2 pairs to verify ordering, got ${projResult.pairs.length}`);
  assertOrdered(projResult.pairs, 'proj store');

  const { cwd } = buildSlackFlakeStore();
  const slackResult = lintStore({ cwd, scope: 'all' });
  assertOrdered(slackResult.pairs, 'slack/flake store');

  // CLI JSON envelope must also be ordered (R9 explicitly applies to JSON).
  const r = runLint([`--cwd=${PROJ_CWD}`, '--scope=all', '--json']);
  const env = parseJson(r.stdout);
  assert.ok(env, `CLI JSON must parse, stdout=${r.stdout}`);
  assertOrdered(env.pairs, 'CLI JSON envelope');
});

test('Task 8 (c) — formatHuman renders header → cause → suggestion → overlap+severity (AC-G10)', () => {
  const { cwd } = buildSlackFlakeStore();
  const { lintStore, formatHuman } = require(CLI);
  const result = lintStore({ cwd, scope: 'all' });
  const text = formatHuman(result);
  assert.equal(typeof text, 'string', `formatHuman must return a string, got ${typeof text}`);
  assert.ok(text.length > 0, 'formatHuman output must be non-empty');

  // Find the slack/flake block. The pair header must use the form `A ⇄ B`
  // (per tasks.md §Acceptance Criteria). The block then contains, IN ORDER:
  //   cause line, suggestion line, overlap-rate + `[severity: <tier>]` tag.
  const slackPair = result.pairs.find(
    (p) =>
      p.rule === 'trigger-body-overlap' &&
      [p.a, p.b].sort().join('|') ===
        ['flaky-test-fix-protocol', 'slack-handoff-ask-before-clipboard'].join('|')
  );
  assert.ok(slackPair, 'slack/flake body pair must exist for human-format assertion');
  const a = slackPair.a;
  const b = slackPair.b;

  // Header must contain both names joined by `⇄`.
  const headerRe = new RegExp(`${a}\\s*⇄\\s*${b}|${b}\\s*⇄\\s*${a}`);
  const headerMatch = text.match(headerRe);
  assert.ok(headerMatch, `formatHuman output must contain a '${a} ⇄ ${b}' header line, got:\n${text}`);
  const blockStart = headerMatch.index;
  // Block ends at the next header (or end of string).
  const rest = text.slice(blockStart + headerMatch[0].length);
  const nextHeader = rest.search(/\n\S.*⇄/);
  const block = nextHeader === -1 ? rest : rest.slice(0, nextHeader);

  // Identify the four ordered elements WITHIN the block.
  // - cause: mentions the rule (e.g. "trigger-body-overlap") or the matched token "slack".
  // - suggestion: equals (or contains) the pair's suggestion string.
  // - overlap-rate + severity tag: contains "[severity: high]" plus a numeric
  //   rate (score or jaccard-style number).
  const idxCause = Math.max(
    block.indexOf('trigger-body-overlap'),
    block.toLowerCase().indexOf('cause')
  );
  const idxSuggestion = block.indexOf(slackPair.suggestion);
  const idxSeverityTag = block.indexOf('[severity: high]');

  assert.ok(idxCause >= 0, `block must contain a cause line, got:\n${block}`);
  assert.ok(idxSuggestion >= 0, `block must contain the suggestion line "${slackPair.suggestion}", got:\n${block}`);
  assert.ok(idxSeverityTag >= 0, `block must contain "[severity: high]" tag, got:\n${block}`);

  assert.ok(
    idxCause < idxSuggestion,
    `cause line must precede suggestion line (cause@${idxCause}, suggestion@${idxSuggestion})`
  );
  assert.ok(
    idxSuggestion < idxSeverityTag,
    `suggestion line must precede severity tag (suggestion@${idxSuggestion}, severityTag@${idxSeverityTag})`
  );

  // The overlap rate (numeric) must appear on the same line as the severity
  // tag (per tasks.md "overlap rate + [severity: <tier>] tag" — single line).
  const severityLine = block.slice(block.lastIndexOf('\n', idxSeverityTag) + 1).split('\n')[0];
  assert.ok(
    /\d/.test(severityLine),
    `severity-tag line must include the overlap rate, got line="${severityLine}"`
  );
});

// ─── Task 9: synapsys memorize post-write lint hook (AC-G6) ───

const MEMORIZE_CLI = path.join(__dirname, '..', 'scripts', 'synapsys-memorize.js');

test('synapsys memorize warns on a new high-severity pair before commit (AC-G6)', () => {
  // Build an isolated store seeded with the `flaky-test-fix-protocol` memory.
  // The new memorize call writes the colliding `slack-handoff-ask-before-clipboard`
  // memory whose trigger tokens match ≥4 tokens of the flake body, triggering
  // a `trigger-body-overlap` high-severity pair (mirrors AC-G1 collision).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-lint-task9-'));
  const storeDir = path.join(root, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), '{"version":1,"kind":"project"}\n');
  fs.copyFileSync(FLAKE_FIXTURE, path.join(storeDir, 'flaky-test-fix-protocol.md'));
  const isolatedHome = path.join(root, 'home');
  fs.mkdirSync(isolatedHome, { recursive: true });

  // Body for the new memory — re-use the slack fixture body so the
  // trigger-body-overlap collision is identical to AC-G1.
  const slackBody = [
    'When the user requests a handoff, do not push the handoff body to slack or the',
    'clipboard until you have explicitly confirmed the recipient channel. The slack',
    'target frequently changes mid-conversation; assuming the previous slack',
    'channel is still correct will leak context.',
  ].join('\n');

  const r = spawnSync(
    process.execPath,
    [
      MEMORIZE_CLI,
      '--name=slack-handoff-ask-before-clipboard',
      '--desc=Before pasting handoff content to slack, always confirm with the user.',
      '--events=UserPromptSubmit',
      '--prompt=\\b(slack|clipboard|handoff)\\b',
      '--store=local',
      `--cwd=${root}`,
    ],
    {
      encoding: 'utf8',
      input: slackBody,
      env: Object.assign({}, process.env, { HOME: isolatedHome, NO_COLOR: '1' }),
    }
  );

  // AC-G6: memorize exit code remains 0 (warn, not block).
  assert.equal(
    r.status,
    0,
    `expected memorize exit 0 (warn-not-block), got ${r.status}. stderr=${r.stderr}\nstdout=${r.stdout}`
  );

  // The written file must exist.
  const writtenPath = path.join(storeDir, 'slack-handoff-ask-before-clipboard.md');
  assert.ok(
    fs.existsSync(writtenPath),
    `expected memorize to write ${writtenPath}, file missing. stderr=${r.stderr}`
  );

  // AC-G6: stderr warns with the substring "high severity".
  assert.ok(
    r.stderr.includes('high severity'),
    `expected stderr to contain "high severity", got stderr=${JSON.stringify(r.stderr)}`
  );

  // AC-G6: stderr names the colliding memory.
  assert.ok(
    r.stderr.includes('flaky-test-fix-protocol'),
    `expected stderr to name colliding memory 'flaky-test-fix-protocol', got stderr=${JSON.stringify(r.stderr)}`
  );
});
