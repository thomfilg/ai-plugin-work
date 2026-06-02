'use strict';

/**
 * Tests for `plugins/synapsys/scripts/synapsys-replay.js` (GH-444).
 *
 * Task 1 RED — Scaffold CLI shell + flag parser.
 *
 * Covers R10 (all CLI flags + defaults), spec §CLI (exit 2 on invalid
 * `--since`), spec §Arch (test-only `module.exports.parseFlags`).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPLAY = path.resolve(__dirname, '..', '..', 'scripts', 'synapsys-replay.js');

test('parseFlags returns documented defaults when no argv provided', () => {
  const { parseFlags } = require(REPLAY);
  const parsed = parseFlags([]);
  assert.equal(parsed.since, '7d', 'default --since=7d');
  assert.equal(parsed.maxJudges, 200, 'default --max-judges=200');
  assert.equal(parsed.noJudge, false);
  assert.equal(parsed.json, false);
  assert.equal(parsed.project, undefined);
  assert.equal(parsed.only, undefined);
  assert.equal(parsed.store, undefined);
});

test('parseFlags reads all R10 flags from argv', () => {
  const { parseFlags } = require(REPLAY);
  const parsed = parseFlags([
    '--since=14d',
    '--project=abc123',
    '--no-judge',
    '--json',
    '--only=mem-a,mem-b',
    '--store=my-store',
    '--max-judges=50',
  ]);
  assert.equal(parsed.since, '14d');
  assert.equal(parsed.project, 'abc123');
  assert.equal(parsed.noJudge, true);
  assert.equal(parsed.json, true);
  assert.equal(parsed.only, 'mem-a,mem-b');
  assert.equal(parsed.store, 'my-store');
  assert.equal(parsed.maxJudges, 50);
});

test('parseFlags coerces --max-judges to a number', () => {
  const { parseFlags } = require(REPLAY);
  const parsed = parseFlags(['--max-judges=42']);
  assert.equal(typeof parsed.maxJudges, 'number');
  assert.equal(parsed.maxJudges, 42);
});

test('CLI exits 2 on invalid --since (not matching /^\\d+d$/)', () => {
  const result = spawnSync(process.execPath, [REPLAY, '--since=abc', '--no-judge'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2, 'exit code 2 for invalid --since');
  assert.match(result.stderr, /since/i);
});

test('CLI exits 2 on --project values that allow path traversal', () => {
  for (const bad of ['..', '.', 'a..b', '../etc']) {
    const result = spawnSync(process.execPath, [REPLAY, '--project=' + bad, '--no-judge'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 2, `--project=${bad} should exit 2`);
    assert.match(result.stderr, /project/i);
  }
});

test('CLI exits 2 on non-numeric --max-judges', () => {
  const result = spawnSync(process.execPath, [REPLAY, '--max-judges=abc', '--no-judge'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2, '--max-judges=abc should exit 2');
  assert.match(result.stderr, /max-judges/i);
});

test('walkTranscripts defaults to the cwd-derived project (not every project)', () => {
  const { walkTranscripts } = require(REPLAY);
  const os5 = require('node:os');
  const fs5 = require('node:fs');
  const path5 = require('node:path');
  const root = fs5.mkdtempSync(path5.join(os5.tmpdir(), 'syn-projects-'));
  // Two project dirs: one matching cwd hash, one not.
  const cwd = '/fake/cwd/path';
  const matching = cwd.split(path5.sep).join('-'); // -fake-cwd-path
  const other = '-some-other-project';
  fs5.mkdirSync(path5.join(root, matching));
  fs5.mkdirSync(path5.join(root, other));
  fs5.writeFileSync(
    path5.join(root, matching, 'a.jsonl'),
    '{"type":"user","message":{"content":"x"}}\n'
  );
  fs5.writeFileSync(
    path5.join(root, other, 'b.jsonl'),
    '{"type":"user","message":{"content":"y"}}\n'
  );

  const onlyCwd = walkTranscripts({ since: '7d', baseDir: root, cwd });
  assert.equal(onlyCwd.length, 1, 'default scans ONLY the cwd-hashed project');
  assert.ok(onlyCwd[0].includes(matching), 'walked the matching project dir');

  const all = walkTranscripts({ since: '7d', baseDir: root, cwd, allProjects: true });
  assert.equal(all.length, 2, '--all-projects scans every project dir');

  fs5.rmSync(root, { recursive: true, force: true });
});

test('suggestTightening fires for realistic \\b(...)\\b wrapped triggers', () => {
  const { suggestTightening } = require(REPLAY);
  const memory = { name: 'noisy', triggerPrompt: '\\b(push|fetch|run)\\b' };
  const agg = { fp_rate: 0.8 };
  const result = suggestTightening(memory, agg);
  assert.ok(result, 'wrapped trigger should produce a suggestion');
  assert.deepEqual(result.candidates.sort(), ['fetch', 'push', 'run']);
});

test('extractEvents skips synthetic user messages (slash commands, system reminders, tool results)', () => {
  const { extractEvents } = require(REPLAY);
  const cases = [
    { type: 'user', message: { content: '<command-name>foo</command-name>' } },
    { type: 'user', message: { content: '<system-reminder>x</system-reminder>' } },
    { type: 'user', message: { content: '<local-command-stdout>out</local-command-stdout>' } },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] },
    },
    { type: 'user', isMeta: true, message: { content: 'real user prompt' } },
  ];
  for (const c of cases) {
    assert.deepEqual(
      extractEvents(c),
      [],
      `should skip synthetic case: ${JSON.stringify(c).slice(0, 60)}`
    );
  }
  // Real prompt still fires
  const real = extractEvents({ type: 'user', message: { content: 'fix the login bug' } });
  assert.equal(real.length, 1);
  assert.equal(real[0].event, 'UserPromptSubmit');
});

test('CLI exits 2 when --only references only unknown memory names (misconfig contract)', () => {
  const os3 = require('node:os');
  const fs3 = require('node:fs');
  const path3 = require('node:path');
  const tmpStore = fs3.mkdtempSync(path3.join(os3.tmpdir(), 'syn-store-'));
  fs3.writeFileSync(path3.join(tmpStore, '.synapsys.json'), '{}');
  fs3.writeFileSync(
    path3.join(tmpStore, 'real-memory.md'),
    '---\nname: real-memory\ndescription: x\nevents: UserPromptSubmit\ntrigger_prompt: foo\n---\nbody\n'
  );
  const tmpTx = fs3.mkdtempSync(path3.join(os3.tmpdir(), 'syn-tx-'));
  const result = spawnSync(
    process.execPath,
    [
      REPLAY,
      '--no-judge',
      `--store=${tmpStore}`,
      '--only=does-not-exist,also-typo',
      `--transcripts-base=${tmpTx}`,
    ],
    { encoding: 'utf8' }
  );
  fs3.rmSync(tmpStore, { recursive: true, force: true });
  fs3.rmSync(tmpTx, { recursive: true, force: true });
  assert.equal(result.status, 2, `expected exit 2, got ${result.status}: ${result.stderr}`);
  assert.match(result.stderr, /only.*matched no memories|unknown/i);
});

test('CLI emits stderr warning and falls back to no-judge when ANTHROPIC_API_KEY is missing (AC5)', () => {
  const os4 = require('node:os');
  const fs4 = require('node:fs');
  const path4 = require('node:path');
  const tmp = fs4.mkdtempSync(path4.join(os4.tmpdir(), 'syn-cli-nokey-'));
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  // Intentionally NO --no-judge: this exercises the missing-key fallback path.
  const result = spawnSync(
    process.execPath,
    [REPLAY, '--since=7d', `--transcripts-base=${tmp}`, '--json'],
    { encoding: 'utf8', env }
  );
  fs4.rmSync(tmp, { recursive: true, force: true });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  const warnings = result.stderr.match(/ANTHROPIC_API_KEY not set/g) || [];
  assert.equal(warnings.length, 1, `expected exactly one stderr warning, got: ${result.stderr}`);
  assert.match(result.stderr, /proceeding as --no-judge/i);
});

test('CLI exits 0 and emits report JSON in --no-judge mode (Task 8 wired main)', () => {
  // Task 1 scaffold expected an echo of parsed flags. Task 8 wires main() to
  // the real pipeline, so we now assert the wired JSON shape against an empty
  // hermetic transcripts dir (no-transcripts message path is covered separately
  // in the @task:8 cases). We point --transcripts-base at a missing dir so the
  // pipeline exits 0 via the friendly no-transcripts branch.
  const os2 = require('node:os');
  const fs2 = require('node:fs');
  const tmp = fs2.mkdtempSync(require('node:path').join(os2.tmpdir(), 'syn-cli-'));
  const result = spawnSync(
    process.execPath,
    [REPLAY, '--since=7d', '--no-judge', '--max-judges=10', `--transcripts-base=${tmp}`],
    { encoding: 'utf8' }
  );
  fs2.rmSync(tmp, { recursive: true, force: true });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /no transcripts in window/i);
});

/**
 * Task 2 RED — `extractEvents(parsedLine)` pure function (G1 + G2, R2).
 *
 * Synthesizes `{event:'UserPromptSubmit', prompt}` from `type=user` entries
 * and `{event:'PreToolUse', tool, tool_input}` per `tool_use` block from
 * `type=assistant` entries. Everything else returns `[]`.
 */

test('extractEvents synthesizes UserPromptSubmit from a user transcript entry (P0 #2)', () => {
  const { extractEvents } = require(REPLAY);

  // Plain string `content` shape.
  const stringForm = extractEvents({
    type: 'user',
    message: { content: 'fix the auth bug' },
  });
  assert.deepEqual(stringForm, [{ event: 'UserPromptSubmit', prompt: 'fix the auth bug' }]);

  // Array `content` shape with text block.
  const arrayForm = extractEvents({
    type: 'user',
    message: { content: [{ type: 'text', text: 'refactor the parser' }] },
  });
  assert.deepEqual(arrayForm, [{ event: 'UserPromptSubmit', prompt: 'refactor the parser' }]);

  // Unrelated entry types yield no events.
  assert.deepEqual(extractEvents({ type: 'system', message: { content: 'hi' } }), []);
  assert.deepEqual(extractEvents({ type: 'summary' }), []);
});

test('extractEvents synthesizes PreToolUse from an assistant tool_use block (P0 #2)', () => {
  const { extractEvents } = require(REPLAY);

  const single = extractEvents({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: 'I will read the file.' },
        {
          type: 'tool_use',
          id: 'toolu_1',
          name: 'Read',
          input: { file_path: '/tmp/x.txt' },
        },
      ],
    },
  });
  assert.deepEqual(single, [
    { event: 'PreToolUse', tool: 'Read', tool_input: { file_path: '/tmp/x.txt' } },
  ]);

  // Multiple tool_use blocks → one PTU event per block, in order.
  const multi = extractEvents({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
        { type: 'tool_use', name: 'Grep', input: { pattern: 'foo' } },
      ],
    },
  });
  assert.deepEqual(multi, [
    { event: 'PreToolUse', tool: 'Bash', tool_input: { command: 'ls' } },
    { event: 'PreToolUse', tool: 'Grep', tool_input: { pattern: 'foo' } },
  ]);

  // Assistant entry with only text content → no events.
  const textOnly = extractEvents({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'done' }] },
  });
  assert.deepEqual(textOnly, []);
});

/**
 * Task 3 RED — `walkTranscripts({since, project, baseDir})` + `parseSince` +
 * `iterLines` (R1, R12 walker-level).
 *
 * @task:3
 *
 * Tagged with `@task:3` so the TDD harness binds these tests to the Task 3
 * gate (avoids the unit-only fallback). All four cases MUST fail before
 * Task 3 GREEN — `walkTranscripts`, `parseSince`, and `iterLines` are not
 * yet exported by synapsys-replay.js.
 */

const fs = require('node:fs');
const os = require('node:os');

function mkProjectsFixture() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-walk-'));
  const projHash = '-tmp-some-project';
  const projDir = path.join(baseDir, projHash);
  fs.mkdirSync(projDir, { recursive: true });
  return { baseDir, projHash, projDir };
}

test('@task:3 walkTranscripts returns *.jsonl files modified within --since window', () => {
  const { walkTranscripts } = require(REPLAY);
  const { baseDir, projDir } = mkProjectsFixture();

  const fresh = path.join(projDir, 'fresh.jsonl');
  const stale = path.join(projDir, 'stale.jsonl');
  const notJsonl = path.join(projDir, 'README.md');
  fs.writeFileSync(fresh, '{"type":"user","message":{"content":"hi"}}\n');
  fs.writeFileSync(stale, '{"type":"user","message":{"content":"old"}}\n');
  fs.writeFileSync(notJsonl, 'ignore me');

  // Backdate stale file to 30 days ago.
  const thirtyDaysAgo = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(stale, thirtyDaysAgo, thirtyDaysAgo);

  const files = walkTranscripts({ since: '7d', baseDir });
  assert.ok(Array.isArray(files), 'returns array');
  assert.ok(files.includes(fresh), 'includes fresh file');
  assert.ok(!files.includes(stale), 'excludes stale file');
  assert.ok(!files.includes(notJsonl), 'excludes non-jsonl');

  fs.rmSync(baseDir, { recursive: true, force: true });
});

/**
 * Task 4 RED — `replayEvent(memories, event)` + matcher integration (R3, G3).
 *
 * @task:4
 *
 * These tests bind to the Task 4 gate. They MUST fail before Task 4 GREEN —
 * `replayEvent`, `loadStore`, and `loadMemories` are not yet exported by
 * synapsys-replay.js. Coverage:
 *   - per-memory tuple shape `{memory_name, event, fired, matched_substring}`
 *   - fire / no-fire dispatch by event type
 *   - matched_substring sourced from `matched.prompt_substring` (UPS)
 *     and `matched.content_substring` (PTU)
 *   - loadStore reuses memory-store.discoverStores
 *   - loadMemories reuses memory-store.listMemoriesFromStore
 */

function mkUpsMemory(overrides = {}) {
  return {
    name: 'ups-bug',
    events: ['UserPromptSubmit'],
    triggerPrompt: 'auth bug|login',
    triggerPretool: [],
    triggerPretoolContent: [],
    triggerPretoolContentNot: [],
    disabled: false,
    expired: false,
    ...overrides,
  };
}

function mkPtuMemory(overrides = {}) {
  return {
    name: 'ptu-write',
    events: ['PreToolUse'],
    triggerPrompt: '',
    triggerPretool: ['Write'],
    triggerPretoolContent: ['TODO|FIXME'],
    triggerPretoolContentNot: [],
    disabled: false,
    expired: false,
    ...overrides,
  };
}

test('@task:4 replayEvent returns per-memory tuple for a UserPromptSubmit event with matched substring', () => {
  const { replayEvent } = require(REPLAY);
  const memories = [mkUpsMemory(), mkPtuMemory()];
  const event = { event: 'UserPromptSubmit', prompt: 'please fix the auth bug today' };
  const tuples = replayEvent(memories, event);

  assert.ok(Array.isArray(tuples), 'returns an array');
  assert.equal(tuples.length, 2, 'one tuple per memory');

  const ups = tuples.find((t) => t.memory_name === 'ups-bug');
  assert.ok(ups, 'tuple exists for ups-bug');
  assert.equal(ups.event, 'UserPromptSubmit');
  assert.equal(ups.fired, true);
  assert.equal(
    ups.matched_substring,
    'auth bug',
    'matched_substring from matched.prompt_substring'
  );

  const ptu = tuples.find((t) => t.memory_name === 'ptu-write');
  assert.ok(ptu, 'tuple exists for ptu-write');
  assert.equal(ptu.event, 'UserPromptSubmit');
  assert.equal(ptu.fired, false, 'PTU memory does not fire on UPS event');
});

test('@task:4 replayEvent dispatches PreToolUse to matchPreTool and reads content_substring', () => {
  const { replayEvent } = require(REPLAY);
  const memories = [mkUpsMemory(), mkPtuMemory()];
  const event = {
    event: 'PreToolUse',
    tool: 'Write',
    tool_input: { content: 'add TODO before shipping' },
  };
  const tuples = replayEvent(memories, event);

  assert.equal(tuples.length, 2);
  const ups = tuples.find((t) => t.memory_name === 'ups-bug');
  assert.equal(ups.fired, false, 'UPS memory does not fire on PTU event');

  const ptu = tuples.find((t) => t.memory_name === 'ptu-write');
  assert.equal(ptu.event, 'PreToolUse');
  assert.equal(ptu.fired, true);
  assert.equal(ptu.matched_substring, 'TODO', 'matched_substring from matched.content_substring');
});

test('@task:4 replayEvent no-fire tuple has matched_substring undefined and fired=false', () => {
  const { replayEvent } = require(REPLAY);
  const memories = [mkUpsMemory()];
  const tuples = replayEvent(memories, {
    event: 'UserPromptSubmit',
    prompt: 'nothing relevant here',
  });
  assert.equal(tuples.length, 1);
  assert.equal(tuples[0].fired, false);
  assert.equal(tuples[0].matched_substring, undefined);
});

test('@task:4 loadStore reuses discoverStores; unknown --store exits with code 2', () => {
  const { loadStore } = require(REPLAY);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-load-'));
  // Mark a fake local store so discoverStores finds it.
  const storeDir = path.join(tmp, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), '{}');

  const allStores = loadStore({ storeFlag: undefined, cwd: tmp });
  assert.ok(Array.isArray(allStores), 'returns array');
  assert.ok(
    allStores.some((s) => s.kind === 'local'),
    'discovers local store'
  );

  // Path-based selector.
  const byPath = loadStore({ storeFlag: storeDir, cwd: tmp });
  assert.equal(byPath.length, 1);
  assert.equal(path.resolve(byPath[0].dir), path.resolve(storeDir));

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('@task:4 loadMemories reuses listMemoriesFromStore and returns parsed memory objects', () => {
  const { loadMemories } = require(REPLAY);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-mems-'));
  const storeDir = path.join(tmp, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), '{}');
  fs.writeFileSync(
    path.join(storeDir, 'sample.md'),
    [
      '---',
      'name: sample',
      'description: test memory',
      'events: UserPromptSubmit',
      'trigger_prompt: hello',
      '---',
      'body',
      '',
    ].join('\n')
  );

  const store = { kind: 'local', dir: storeDir, projectName: 'x' };
  const mems = loadMemories([store]);
  assert.equal(mems.length, 1);
  assert.equal(mems[0].name, 'sample');
  assert.equal(mems[0].triggerPrompt, 'hello');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('@task:3 walkTranscripts honors --project filter and empty window returns []', () => {
  const { walkTranscripts } = require(REPLAY);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-walk-'));

  const projA = path.join(baseDir, '-proj-a');
  const projB = path.join(baseDir, '-proj-b');
  fs.mkdirSync(projA, { recursive: true });
  fs.mkdirSync(projB, { recursive: true });
  const fileA = path.join(projA, 't.jsonl');
  const fileB = path.join(projB, 't.jsonl');
  fs.writeFileSync(fileA, '{}\n');
  fs.writeFileSync(fileB, '{}\n');

  const onlyA = walkTranscripts({ since: '7d', project: '-proj-a', baseDir });
  assert.ok(onlyA.includes(fileA), 'project filter includes target');
  assert.ok(!onlyA.includes(fileB), 'project filter excludes other');

  // Empty / non-existent baseDir → [] without throwing (R12 walker level).
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-empty-'));
  const empty = walkTranscripts({ since: '7d', baseDir: emptyDir });
  assert.deepEqual(empty, []);

  fs.rmSync(baseDir, { recursive: true, force: true });
  fs.rmSync(emptyDir, { recursive: true, force: true });
});

test('@task:3 parseSince converts Nd to ms; invalid format throws', () => {
  const { parseSince } = require(REPLAY);
  assert.equal(parseSince('7d'), 7 * 24 * 60 * 60 * 1000);
  assert.equal(parseSince('1d'), 24 * 60 * 60 * 1000);
  assert.equal(parseSince('30d'), 30 * 24 * 60 * 60 * 1000);
  assert.throws(() => parseSince('abc'), /since/i);
  assert.throws(() => parseSince('7'), /since/i);
  assert.throws(() => parseSince(''), /since/i);
});

test('@task:3 iterLines yields parsed JSON; malformed lines warn to stderr and are skipped', () => {
  const { iterLines } = require(REPLAY);
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-iter-'));
  const filePath = path.join(baseDir, 'mixed.jsonl');
  fs.writeFileSync(
    filePath,
    [
      '{"type":"user","message":{"content":"one"}}',
      'not-valid-json{',
      '{"type":"assistant","message":{"content":[]}}',
      '',
      '{"type":"system"}',
    ].join('\n') + '\n'
  );

  // Capture stderr writes during the iteration.
  const origWrite = process.stderr.write.bind(process.stderr);
  const stderrChunks = [];
  process.stderr.write = (chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  };

  let parsed;
  try {
    parsed = Array.from(iterLines(filePath));
  } finally {
    process.stderr.write = origWrite;
  }

  assert.equal(parsed.length, 3, 'three valid JSON entries (malformed + empty skipped)');
  assert.equal(parsed[0].type, 'user');
  assert.equal(parsed[1].type, 'assistant');
  assert.equal(parsed[2].type, 'system');
  const stderrAll = stderrChunks.join('');
  assert.match(stderrAll, /malformed|skip|parse/i, 'warned about malformed line');

  fs.rmSync(baseDir, { recursive: true, force: true });
});

/**
 * Task 5 RED — `aggregateReport` + `suggestTightening` + `splitTopLevelAlternation`
 * (R5 arithmetic, R7 judge-failed bookkeeping, R8 heuristic, G5, G7).
 *
 * @task:5
 *
 * Tagged with `@task:5` so the TDD harness binds these tests to the Task 5
 * gate. They MUST fail before Task 5 GREEN — `aggregateReport`,
 * `suggestTightening`, and `splitTopLevelAlternation` are not yet exported.
 */

test('@task:5 judge call is mocked and per-memory relevance is computed correctly (P0 #5)', () => {
  const { aggregateReport } = require(REPLAY);

  // Two memories, mixed events. Tuples are the output of replayEvent across
  // a series of events; only `fired=true` rows feed the judge.
  const tuples = [
    // ups-bug: 5 fires (3 relevant, 1 irrelevant, 1 judge-failed) → fp = 1 - 3/4 = 0.25
    {
      memory_name: 'ups-bug',
      event: 'UserPromptSubmit',
      fired: true,
      matched_substring: 'auth bug',
    },
    {
      memory_name: 'ups-bug',
      event: 'UserPromptSubmit',
      fired: true,
      matched_substring: 'auth bug',
    },
    { memory_name: 'ups-bug', event: 'UserPromptSubmit', fired: true, matched_substring: 'login' },
    { memory_name: 'ups-bug', event: 'UserPromptSubmit', fired: true, matched_substring: 'login' },
    {
      memory_name: 'ups-bug',
      event: 'UserPromptSubmit',
      fired: true,
      matched_substring: 'auth bug',
    },
    {
      memory_name: 'ups-bug',
      event: 'UserPromptSubmit',
      fired: false,
      matched_substring: undefined,
    },
    // ptu-write: PTU-only memory → not judged in v1 → relevant=null, fp_rate=null
    { memory_name: 'ptu-write', event: 'PreToolUse', fired: true, matched_substring: 'TODO' },
    { memory_name: 'ptu-write', event: 'PreToolUse', fired: true, matched_substring: 'FIXME' },
  ];

  // Mocked judge output keyed by tuple identity (index into fired-tuples in
  // ups-bug's slice). aggregateReport receives a `judgments` map per
  // memory_name with `relevant[]`, `irrelevant[]`, `judge_failed` counts.
  const judgments = {
    'ups-bug': { relevant: 3, irrelevant: 1, judge_failed: 1 },
  };

  const report = aggregateReport(tuples, judgments);
  assert.ok(report && typeof report === 'object', 'returns object');
  const ups =
    report['ups-bug'] || (Array.isArray(report) && report.find((m) => m.name === 'ups-bug'));
  const ptu =
    report['ptu-write'] || (Array.isArray(report) && report.find((m) => m.name === 'ptu-write'));
  assert.ok(ups, 'ups-bug entry present');
  assert.ok(ptu, 'ptu-write entry present');

  assert.equal(ups.fires, 5, 'fires counts only fired=true');
  assert.equal(ups.relevant, 3);
  assert.equal(ups.irrelevant, 1);
  assert.equal(ups.judge_failed, 1);
  // fp_rate = 1 - relevant / (relevant + irrelevant); judge_failed excluded
  assert.equal(ups.fp_rate, 1 - 3 / 4);

  // sample_matches top-3 most-frequent distinct substrings.
  assert.ok(Array.isArray(ups.sample_matches));
  assert.ok(ups.sample_matches.includes('auth bug'));
  assert.ok(ups.sample_matches.includes('login'));
  assert.ok(ups.sample_matches.length <= 3);

  // PTU-only memory: not judged in v1.
  assert.equal(ptu.fires, 2);
  assert.equal(ptu.relevant, null);
  assert.equal(ptu.fp_rate, null);
});

test('@task:5 heuristic tightening suggestion fires for fp_rate > 0.70 with short alternation arms (P0 #8)', () => {
  const { suggestTightening, splitTopLevelAlternation } = require(REPLAY);

  // splitTopLevelAlternation splits on top-level `|` only.
  assert.deepEqual(splitTopLevelAlternation('push|fetch|deploy-production'), [
    'push',
    'fetch',
    'deploy-production',
  ]);
  // Top-level only — `|` inside `(...)` is not split. Brackets are NOT
  // depth-tracked (matches matcher.js semantics exactly).
  assert.deepEqual(splitTopLevelAlternation('(a|b)|cd|ef'), ['(a|b)', 'cd', 'ef']);
  // Backslash-escaped `|` is not a separator.
  assert.deepEqual(splitTopLevelAlternation('auth\\|login|admin'), ['auth\\|login', 'admin']);

  // Memory with short alternation arms and high fp_rate → suggestion.
  const noisyMem = {
    name: 'noisy',
    triggerPrompt: 'push|fetch|deploy-production',
  };
  const agg = {
    fires: 10,
    relevant: 2,
    irrelevant: 8,
    judge_failed: 0,
    fp_rate: 0.8,
    sample_matches: ['push', 'fetch'],
  };
  const suggestion = suggestTightening(noisyMem, agg);
  assert.ok(suggestion, 'returns suggestion when fp_rate > 0.70 + short arms');
  assert.equal(suggestion.memory, 'noisy');
  assert.ok(Array.isArray(suggestion.candidates));
  assert.ok(suggestion.candidates.includes('push'), 'flags short arm push');
  assert.ok(suggestion.candidates.includes('fetch'), 'flags short arm fetch');
  assert.ok(!suggestion.candidates.includes('deploy-production'), 'does not flag long arm');

  // fp_rate <= 0.70 → no suggestion.
  const okAgg = {
    fires: 10,
    relevant: 5,
    irrelevant: 5,
    judge_failed: 0,
    fp_rate: 0.5,
    sample_matches: [],
  };
  assert.equal(suggestTightening(noisyMem, okAgg), null, 'no suggestion when fp_rate <= 0.70');

  // High fp_rate but no short arms → no suggestion.
  const longMem = { name: 'long', triggerPrompt: 'deploy-production|rollback-stage' };
  assert.equal(suggestTightening(longMem, agg), null, 'no suggestion when all arms long');

  // PTU-only memory with fp_rate=null → no suggestion.
  const nullAgg = {
    fires: 5,
    relevant: null,
    irrelevant: null,
    judge_failed: 0,
    fp_rate: null,
    sample_matches: [],
  };
  assert.equal(suggestTightening(noisyMem, nullAgg), null, 'no suggestion when fp_rate is null');
});

/**
 * Task 6 RED — `renderJson` + `renderReport` output (R9, R11, R17, G6).
 *
 * @task:6
 *
 * Tagged with `@task:6` so the TDD harness binds these tests to the Task 6
 * gate. They MUST fail before Task 6 GREEN — `renderJson` and `renderReport`
 * are not yet exported by synapsys-replay.js.
 *
 * Covers:
 *   - --json output shape includes memories, suggestions, and event totals (P0 #9, #11)
 *   - text report header + per-memory table + Suggestions section
 *   - cost footer present only when judge ran
 *   - ANTHROPIC_API_KEY value never appears in any rendered output
 */

test('@task:6 --json output shape includes memories, suggestions, and event totals (P0 #9, #11)', () => {
  const { renderJson } = require(REPLAY);

  const agg = {
    'ups-bug': {
      fires: 5,
      relevant: 3,
      irrelevant: 1,
      judge_failed: 1,
      fp_rate: 0.25,
      sample_matches: ['auth bug', 'login'],
    },
    'ptu-write': {
      fires: 2,
      relevant: null,
      irrelevant: null,
      judge_failed: 0,
      fp_rate: null,
      sample_matches: ['TODO', 'FIXME'],
    },
  };
  const suggestions = [{ memory: 'noisy', candidates: ['push', 'fetch'] }];
  const meta = {
    store: 'local',
    window: '7d',
    events_total: 12,
    events_ups: 7,
    events_ptu: 5,
    judgeCalls: 4,
  };

  const out = renderJson(agg, suggestions, meta);
  assert.equal(typeof out, 'string', 'renderJson returns a string');
  const parsed = JSON.parse(out);

  // Top-level keys.
  for (const k of ['memories', 'suggestions', 'events_total', 'events_ups', 'events_ptu']) {
    assert.ok(Object.prototype.hasOwnProperty.call(parsed, k), `top-level key ${k} present`);
  }
  assert.equal(parsed.events_total, 12);
  assert.equal(parsed.events_ups, 7);
  assert.equal(parsed.events_ptu, 5);

  // memories shape.
  assert.ok(Array.isArray(parsed.memories), 'memories is an array');
  assert.equal(parsed.memories.length, 2);
  for (const m of parsed.memories) {
    for (const k of [
      'name',
      'fires',
      'relevant',
      'irrelevant',
      'judge_failed',
      'fp_rate',
      'sample_matches',
    ]) {
      assert.ok(Object.prototype.hasOwnProperty.call(m, k), `memories[].${k} present`);
    }
  }
  const ups = parsed.memories.find((m) => m.name === 'ups-bug');
  assert.equal(ups.fires, 5);
  assert.equal(ups.relevant, 3);
  assert.equal(ups.fp_rate, 0.25);

  // suggestions shape.
  assert.ok(Array.isArray(parsed.suggestions));
  assert.equal(parsed.suggestions.length, 1);
  assert.equal(parsed.suggestions[0].memory, 'noisy');
  assert.deepEqual(parsed.suggestions[0].candidates, ['push', 'fetch']);

  // ANTHROPIC_API_KEY value must not appear in output.
  assert.ok(!out.includes('sk-ant-'), 'no API key prefix in output');
});

test('@task:6 renderReport text contains header, per-memory rows, and Suggestions section', () => {
  const { renderReport } = require(REPLAY);

  const agg = {
    'ups-bug': {
      fires: 5,
      relevant: 3,
      irrelevant: 1,
      judge_failed: 1,
      fp_rate: 0.25,
      sample_matches: ['auth bug', 'login'],
    },
  };
  const suggestions = [{ memory: 'noisy', candidates: ['push', 'fetch'] }];
  const meta = {
    store: 'local',
    window: '7d',
    events_total: 12,
    events_ups: 7,
    events_ptu: 5,
    judgeCalls: 4,
  };

  const out = renderReport(agg, suggestions, meta);
  assert.equal(typeof out, 'string');

  // Header line bits.
  assert.match(out, /store=/);
  assert.match(out, /window=/);
  assert.match(out, /events=/);
  assert.match(out, /UPS=/);
  assert.match(out, /PTU=/);

  // Per-memory row.
  assert.match(out, /ups-bug/);

  // Suggestions section.
  assert.match(out, /Suggestions:/);
  assert.match(out, /noisy/);

  // Cost footer present when judge ran.
  assert.match(out, /cost/i);
});

test('@task:6 renderReport cost footer absent under --no-judge (judgeCalls=0)', () => {
  const { renderReport } = require(REPLAY);
  const agg = {
    'ups-bug': {
      fires: 5,
      relevant: null,
      irrelevant: null,
      judge_failed: 0,
      fp_rate: null,
      sample_matches: ['auth bug'],
    },
  };
  const meta = {
    store: 'local',
    window: '7d',
    events_total: 5,
    events_ups: 5,
    events_ptu: 0,
    judgeCalls: 0,
  };
  const out = renderReport(agg, [], meta);
  assert.ok(!/cost/i.test(out), 'no cost footer under --no-judge');
});

test('@task:6 renderJson does not leak ANTHROPIC_API_KEY value', () => {
  const { renderJson } = require(REPLAY);
  const apiKey = 'sk-ant-supersecret-token-1234567890';
  const prev = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = apiKey;
  try {
    const agg = {
      'ups-bug': {
        fires: 1,
        relevant: 1,
        irrelevant: 0,
        judge_failed: 0,
        fp_rate: 0,
        sample_matches: ['x'],
      },
    };
    const out = renderJson(agg, [], {
      store: 'local',
      window: '7d',
      events_total: 1,
      events_ups: 1,
      events_ptu: 0,
      judgeCalls: 1,
    });
    assert.ok(!out.includes(apiKey), 'api key value not in output');
  } finally {
    if (prev === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev;
  }
});

test('@task:6 renderJson orders memories by descending fp_rate (nulls last)', () => {
  const { renderJson } = require(REPLAY);
  const agg = {
    a: {
      fires: 1,
      relevant: null,
      irrelevant: null,
      judge_failed: 0,
      fp_rate: null,
      sample_matches: [],
    },
    b: { fires: 4, relevant: 1, irrelevant: 3, judge_failed: 0, fp_rate: 0.75, sample_matches: [] },
    c: { fires: 2, relevant: 1, irrelevant: 1, judge_failed: 0, fp_rate: 0.5, sample_matches: [] },
    d: {
      fires: 5,
      relevant: null,
      irrelevant: null,
      judge_failed: 0,
      fp_rate: null,
      sample_matches: [],
    },
  };
  const parsed = JSON.parse(renderJson(agg, [], { events_total: 0, events_ups: 0, events_ptu: 0 }));
  const order = parsed.memories.map((m) => m.name);
  assert.deepEqual(
    order,
    ['b', 'c', 'd', 'a'],
    'fp_rate desc, then fires desc, name asc; nulls last'
  );
});

test('@task:6 renderJson uses deterministic top-level key order', () => {
  const { renderJson } = require(REPLAY);
  const out = renderJson({}, [], {
    store: 'local',
    window: '7d',
    events_total: 0,
    events_ups: 0,
    events_ptu: 0,
    judgeCalls: 0,
  });
  // Match key order: memories, suggestions, events_total, events_ups, events_ptu.
  const keyOrderRegex =
    /"memories"[\s\S]*"suggestions"[\s\S]*"events_total"[\s\S]*"events_ups"[\s\S]*"events_ptu"/;
  assert.match(out, keyOrderRegex, 'keys appear in deterministic order');
});

test('@task:6 renderJson includes extrapolated:true when meta.extrapolated is set', () => {
  const { renderJson } = require(REPLAY);
  const out = renderJson({}, [], {
    events_total: 0,
    events_ups: 0,
    events_ptu: 0,
    extrapolated: true,
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.extrapolated, true, 'extrapolated flag surfaced in JSON');
});

test('@task:6 renderJson defaults extrapolated to false when meta omits it', () => {
  const { renderJson } = require(REPLAY);
  const out = renderJson({}, [], { events_total: 0, events_ups: 0, events_ptu: 0 });
  const parsed = JSON.parse(out);
  assert.equal(parsed.extrapolated, false, 'extrapolated defaults to false');
});

test('@task:6 renderReport emits a header note when meta.extrapolated is true', () => {
  const { renderReport } = require(REPLAY);
  const agg = {
    'ups-bug': {
      fires: 5,
      relevant: 3,
      irrelevant: 1,
      judge_failed: 0,
      fp_rate: 0.25,
      sample_matches: ['auth bug'],
    },
  };
  const meta = {
    store: 'local',
    window: '7d',
    events_total: 12,
    events_ups: 7,
    events_ptu: 5,
    judgeCalls: 4,
    extrapolated: true,
  };
  const out = renderReport(agg, [], meta);
  assert.match(out, /extrapolated/i, 'human report mentions extrapolation');
});

test('@task:6 renderReport omits extrapolation note when meta.extrapolated is false', () => {
  const { renderReport } = require(REPLAY);
  const meta = {
    store: 'local',
    window: '7d',
    events_total: 0,
    events_ups: 0,
    events_ptu: 0,
    judgeCalls: 0,
    extrapolated: false,
  };
  const out = renderReport({}, [], meta);
  assert.ok(!/extrapolated/i.test(out), 'no extrapolation note when full dataset judged');
});

/**
 * @task:7
 *
 * Task 7 RED — `judgeBatch` + `sampleForCap` + `--max-judges` enforcement.
 *
 * Tagged with `@task:7` so the TDD harness binds these tests to the Task 7
 * cycle. Covers R5 (HTTP shape), R6 (`--max-judges` cap + extrapolation),
 * R7 (network failure recording), R18 (batch size 10), G8 (cap honored).
 */

test('@task:7 judgeBatch POSTs to anthropic with x-api-key header, haiku model, and numbered 1) ... 2) ... user content', async () => {
  const { judgeBatch } = require(REPLAY);
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: '1: yes\n2: no' }] }),
    };
  };
  const items = [
    { memory: 'mem-a', prompt: 'fix login bug', matched: 'login' },
    { memory: 'mem-b', prompt: 'rename file', matched: 'rename' },
  ];
  const results = await judgeBatch(items, {
    fetchImpl,
    apiKey: 'sk-test-key',
    model: 'claude-haiku-4-5',
  });
  assert.equal(calls.length, 1, 'one POST per batch');
  assert.equal(calls[0].url, 'https://api.anthropic.com/v1/messages');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['x-api-key'], 'sk-test-key');
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model, 'claude-haiku-4-5');
  const userContent = body.messages[0].content;
  assert.match(userContent, /1\)/);
  assert.match(userContent, /2\)/);
  assert.equal(results.length, 2);
  assert.equal(results[0].relevant, true);
  assert.equal(results[1].relevant, false);
});

test('@task:7 judgeBatch marks all items judge-failed on HTTP 500', async () => {
  const { judgeBatch } = require(REPLAY);
  const fetchImpl = async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
    text: async () => 'server error',
  });
  const items = [
    { memory: 'm1', prompt: 'p1', matched: 'x' },
    { memory: 'm2', prompt: 'p2', matched: 'y' },
  ];
  const results = await judgeBatch(items, { fetchImpl, apiKey: 'k', model: 'claude-haiku-4-5' });
  assert.equal(results.length, 2);
  assert.equal(results[0].judge_failed, true);
  assert.equal(results[1].judge_failed, true);
});

test('@task:7 judgeBatch marks individual missing reply items as judge-failed', async () => {
  const { judgeBatch } = require(REPLAY);
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    // Only item 1 has a reply; item 2 missing.
    json: async () => ({ content: [{ type: 'text', text: '1: yes' }] }),
  });
  const items = [
    { memory: 'm1', prompt: 'p1', matched: 'x' },
    { memory: 'm2', prompt: 'p2', matched: 'y' },
  ];
  const results = await judgeBatch(items, { fetchImpl, apiKey: 'k', model: 'claude-haiku-4-5' });
  assert.equal(results[0].relevant, true);
  assert.equal(results[1].judge_failed, true, 'missing reply line → judge-failed');
});

test('@task:7 judgeBatch does not throw on fetch exception; marks all items judge-failed', async () => {
  const { judgeBatch } = require(REPLAY);
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const items = [{ memory: 'm1', prompt: 'p1', matched: 'x' }];
  const results = await judgeBatch(items, { fetchImpl, apiKey: 'k', model: 'claude-haiku-4-5' });
  assert.equal(results.length, 1);
  assert.equal(results[0].judge_failed, true);
});

test('@task:7 judgeBatch error messages never include the apiKey', async () => {
  const { judgeBatch } = require(REPLAY);
  const apiKey = 'sk-super-secret-key-1234567890';
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const items = [{ memory: 'm1', prompt: 'p1', matched: 'x' }];
  const results = await judgeBatch(items, { fetchImpl, apiKey, model: 'claude-haiku-4-5' });
  for (const r of results) {
    if (r.error) assert.ok(!String(r.error).includes(apiKey), 'apiKey leaked into error');
  }
});

test('@task:7 sampleForCap returns items unchanged + extrapolated:false when items.length <= cap', () => {
  const { sampleForCap } = require(REPLAY);
  const items = [{ i: 0 }, { i: 1 }, { i: 2 }];
  const out = sampleForCap(items, 5);
  assert.equal(out.extrapolated, false);
  assert.equal(out.sampled.length, 3);
});

test('@task:7 sampleForCap evenly samples and flags extrapolated:true when items.length > cap', () => {
  const { sampleForCap } = require(REPLAY);
  const items = Array.from({ length: 100 }, (_, i) => ({ i }));
  const out = sampleForCap(items, 10);
  assert.equal(out.extrapolated, true);
  assert.equal(out.sampled.length, 10);
  // Evenly per Math.floor(i * fires / cap): indices 0,10,20,...,90.
  const expected = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90];
  assert.deepEqual(
    out.sampled.map((x) => x.i),
    expected
  );
});

test('@task:7 --max-judges cap is honored as a hard upper bound (P0 #6)', async () => {
  const { judgePipeline } = require(REPLAY);
  const calls = [];
  const fetchImpl = async (_url, opts) => {
    calls.push(opts);
    const body = JSON.parse(opts.body);
    // Count numbered items in user content via "N) " markers.
    const userContent = body.messages[0].content;
    const lines = (userContent.match(/^\d+\)/gm) || []).map((m, i) => `${i + 1}: yes`);
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: lines.join('\n') }] }),
    };
  };
  const items = Array.from({ length: 500 }, (_, i) => ({
    memory: 'm',
    prompt: `p${i}`,
    matched: 'x',
  }));
  const out = await judgePipeline(items, {
    fetchImpl,
    apiKey: 'k',
    model: 'claude-haiku-4-5',
    maxJudges: 50,
  });
  // R18 batches of 10 → ceil(50/10) = 5 fetches max.
  assert.ok(calls.length <= 5, `expected ≤5 fetches, got ${calls.length}`);
  assert.equal(out.extrapolated, true, 'extrapolated when items > cap');
  assert.ok(out.results.length <= 50, 'judged at most cap items');
});

/**
 * Task 8 RED — Wire `main()` end-to-end + no-transcripts + missing-key
 * behavior (R4, R12, AC5, G3, G4, G10, spec §Security).
 *
 * @task:8
 *
 * These spawn-script tests bind to the Task 8 gate. They MUST fail before
 * Task 8 GREEN — `main()` does not yet wire walker → replay → render, and
 * `--transcripts-base` is not yet parsed.
 */

function mkTask8Fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-t8-'));
  // Store dir with two memories: one UPS, one PTU.
  const storeDir = path.join(tmp, 'store', '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), '{}');
  fs.writeFileSync(
    path.join(storeDir, 'ups-bug.md'),
    [
      '---',
      'name: ups-bug',
      'description: ups memory',
      'events: UserPromptSubmit',
      'trigger_prompt: auth bug|login',
      '---',
      'body',
      '',
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(storeDir, 'ptu-write.md'),
    [
      '---',
      'name: ptu-write',
      'description: ptu memory',
      'events: PreToolUse',
      'trigger_pretool: Write',
      'trigger_pretool_content: TODO|FIXME',
      '---',
      'body',
      '',
    ].join('\n')
  );

  // Transcripts base: one project hash dir with one jsonl containing a
  // matching UPS entry and a matching assistant tool_use (Write w/ TODO).
  const baseDir = path.join(tmp, 'projects');
  const projDir = path.join(baseDir, '-tmp-proj');
  fs.mkdirSync(projDir, { recursive: true });
  const jsonl = path.join(projDir, 'session.jsonl');
  fs.writeFileSync(
    jsonl,
    [
      JSON.stringify({ type: 'user', message: { content: 'please fix the auth bug today' } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              name: 'Write',
              input: { content: 'add TODO before shipping' },
            },
          ],
        },
      }),
      '',
    ].join('\n')
  );

  return { tmp, storeDir: path.join(tmp, 'store'), baseDir };
}

test('@task:8 replay against a fixture transcript counts fires per memory using the existing matcher (P0 #1, #3)', () => {
  const { tmp, storeDir, baseDir } = mkTask8Fixture();
  const result = spawnSync(
    process.execPath,
    [
      REPLAY,
      '--since=7d',
      '--no-judge',
      '--json',
      `--store=${path.join(storeDir, '.claude', 'synapsys')}`,
      `--transcripts-base=${baseDir}`,
    ],
    { encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '' } }
  );
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.events_total, 2, 'two synthesized events');
  assert.equal(parsed.events_ups, 1);
  assert.equal(parsed.events_ptu, 1);
  const ups = parsed.memories.find((m) => m.name === 'ups-bug');
  const ptu = parsed.memories.find((m) => m.name === 'ptu-write');
  assert.ok(ups && ptu, 'both memories present in report');
  assert.equal(ups.fires, 1, 'ups-bug fired once');
  assert.equal(ptu.fires, 1, 'ptu-write fired once');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('@task:8 --no-judge mode emits a parseable report without any Anthropic API call (P0 #4, #9)', () => {
  const { tmp, storeDir, baseDir } = mkTask8Fixture();
  // Sentinel: if any fetch fires, the script would see ANTHROPIC_API_KEY and
  // try to judge. --no-judge must short-circuit before any network call. We
  // verify by setting an obviously-invalid key + asserting (a) exit 0 and
  // (b) every memory's relevant is null (no judge ran).
  const result = spawnSync(
    process.execPath,
    [
      REPLAY,
      '--since=7d',
      '--no-judge',
      '--json',
      `--store=${path.join(storeDir, '.claude', 'synapsys')}`,
      `--transcripts-base=${baseDir}`,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, ANTHROPIC_API_KEY: 'sk-should-never-be-used' },
    }
  );
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  assert.ok(Array.isArray(parsed.memories), 'memories array present');
  assert.ok(parsed.memories.length >= 1, 'at least one memory in report');
  for (const m of parsed.memories) {
    assert.equal(m.relevant, null, `${m.name}.relevant=null under --no-judge`);
    assert.equal(m.fp_rate, null, `${m.name}.fp_rate=null under --no-judge`);
  }
  // stderr must not contain any network/fetch error — proves no API call.
  assert.ok(
    !/api\.anthropic\.com|fetch failed|ECONNREFUSED/i.test(result.stderr),
    `stderr clean of network noise; got: ${result.stderr}`
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('@task:8 no-transcripts window exits 0 with a friendly message (P0 #12)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-replay-t8-empty-'));
  // Store with one memory so the load step succeeds; empty transcripts base.
  const storeDir = path.join(tmp, 'store', '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), '{}');
  fs.writeFileSync(
    path.join(storeDir, 'm.md'),
    [
      '---',
      'name: m',
      'description: x',
      'events: UserPromptSubmit',
      'trigger_prompt: anything',
      '---',
      'body',
      '',
    ].join('\n')
  );
  const emptyBase = path.join(tmp, 'projects');
  fs.mkdirSync(emptyBase, { recursive: true });

  const result = spawnSync(
    process.execPath,
    [REPLAY, '--since=7d', '--no-judge', `--store=${storeDir}`, `--transcripts-base=${emptyBase}`],
    { encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '' } }
  );
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert.match(result.stdout, /no transcripts in window/i, 'friendly stdout message');
  assert.equal(result.stderr, '', `stderr must be empty; got: ${result.stderr}`);

  const jsonResult = spawnSync(
    process.execPath,
    [
      REPLAY,
      '--since=7d',
      '--no-judge',
      '--json',
      `--store=${storeDir}`,
      `--transcripts-base=${emptyBase}`,
    ],
    { encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: '' } }
  );
  assert.equal(
    jsonResult.status,
    0,
    `expected exit 0, got ${jsonResult.status}: ${jsonResult.stderr}`
  );
  const parsed = JSON.parse(jsonResult.stdout);
  assert.deepEqual(parsed.memories, [], '--json no-transcripts: memories empty');
  assert.deepEqual(parsed.suggestions, [], '--json no-transcripts: suggestions empty');
  assert.equal(parsed.events_total, 0);
  assert.equal(parsed.events_ups, 0);
  assert.equal(parsed.events_ptu, 0);
  assert.match(parsed.message || '', /no transcripts in window/i);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('@task:6 renderJson includes store/window/judge_calls/items_judged from meta for machine consumers', () => {
  const { renderJson } = require(REPLAY);
  const out = renderJson({}, [], {
    store: 'worktree',
    window: '7d',
    events_total: 42,
    events_ups: 30,
    events_ptu: 12,
    judgeCalls: 4,
    itemsJudged: 35,
    extrapolated: true,
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.store, 'worktree', 'store name surfaced');
  assert.equal(parsed.window, '7d', 'window surfaced');
  assert.equal(parsed.judge_calls, 4, 'judge call count surfaced');
  assert.equal(parsed.items_judged, 35, 'items judged surfaced');
  assert.equal(parsed.extrapolated, true);
});

test('@task:7 judgeBatch includes memory body (first 200 chars) in the user content per spec', async () => {
  const { judgeBatch } = require(REPLAY);
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: '1: yes' }] }),
    };
  };
  const longBody = 'A'.repeat(500);
  const items = [{ memory: 'mem-x', body: longBody, prompt: 'p', matched: 'm' }];
  await judgeBatch(items, { fetchImpl, apiKey: 'k', model: 'claude-haiku-4-5' });
  const body = JSON.parse(calls[0].opts.body);
  const userContent = body.messages[0].content;
  assert.match(userContent, /memory titled mem-x/, 'judge sees memory name with title phrasing');
  assert.match(userContent, /with content "A{200}"/, 'judge sees first 200 chars of body');
  assert.ok(!userContent.includes('A'.repeat(201)), 'body is truncated at 200 chars');
});

test('@task:7 judgeBatch falls back to claude-haiku-4-5 when opts.model is omitted', async () => {
  const { judgeBatch } = require(REPLAY);
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({ content: [{ type: 'text', text: '1: yes' }] }),
    };
  };
  await judgeBatch([{ memory: 'm', body: 'b', prompt: 'p', matched: 'm' }], {
    fetchImpl,
    apiKey: 'k',
  });
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.model, 'claude-haiku-4-5', 'default model used when omitted');
});
