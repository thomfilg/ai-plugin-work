'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listMemoriesFromStore } = require('../memory-store');

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-memstore-unit-'));
  const storeDir = path.join(dir, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), JSON.stringify({ projectName: 'test' }));
  return { storeDir };
}

function writeMemory(storeDir, name, frontmatter) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const content = `---\n${fm}\n---\nbody\n`;
  fs.writeFileSync(path.join(storeDir, name), content);
}

// --- Task 1: cite_signals + telemetry frontmatter surfaced via meta ---

test('readMemoryFile surfaces cite_signals as an array of strings on meta', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'cite.md', {
    name: 'cite',
    description: 'd',
    cite_signals: '[alpha, beta, gamma]',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].meta.cite_signals, ['alpha', 'beta', 'gamma']);
});

test('readMemoryFile surfaces telemetry: false as a boolean on meta', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'opt-out.md', {
    name: 'opt-out',
    description: 'd',
    telemetry: 'false',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].meta.telemetry, false);
});

test('readMemoryFile yields meta.cite_signals === undefined when field absent', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'absent.md', {
    name: 'absent',
    description: 'd',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].meta.cite_signals, undefined);
});

test('readMemoryFile yields meta.telemetry === undefined when field absent (consumers treat as enabled)', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'absent-tel.md', {
    name: 'absent-tel',
    description: 'd',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].meta.telemetry, undefined);
});

// Explicit field-forwarding: the memory object exposes top-level
// `citeSignals` (array of strings or undefined) and `telemetry`
// (boolean or undefined), mirroring the camelCase forwarding pattern
// used for other frontmatter fields (`triggerPretoolContentNot`, etc.).
// Consumers should not have to dig into `meta` for these.

test('readMemoryFile forwards cite_signals to top-level citeSignals (array)', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'cite-top.md', {
    name: 'cite-top',
    description: 'd',
    cite_signals: '[one, two]',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].citeSignals, ['one', 'two']);
});

test('readMemoryFile forwards telemetry to top-level telemetry (boolean false)', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'tel-top.md', {
    name: 'tel-top',
    description: 'd',
    telemetry: 'false',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].telemetry, false);
});

test('readMemoryFile top-level citeSignals is undefined when field absent', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'no-cite.md', {
    name: 'no-cite',
    description: 'd',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].citeSignals, undefined);
});

test('readMemoryFile top-level telemetry is undefined when field absent', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'no-tel.md', {
    name: 'no-tel',
    description: 'd',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].telemetry, undefined);
});

// PR #524 cursor[bot] Medium — inline comma-separated cite_signals must be split
// per the README example `cite_signals: Button, packages/ui, @scope/foo`.
test('readMemoryFile splits inline comma-separated cite_signals into tokens', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'inline-csv.md', {
    name: 'inline-csv',
    description: 'd',
    cite_signals: 'Button, packages/ui, @app/foo',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].citeSignals, ['Button', 'packages/ui', '@app/foo']);
});

test('readMemoryFile keeps a single scalar cite_signal as one token', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'inline-solo.md', {
    name: 'inline-solo',
    description: 'd',
    cite_signals: 'solo',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.deepEqual(memories[0].citeSignals, ['solo']);
});

// PR #524 cursor[bot] Low — single-element bracket scalar must drop the brackets
test('readMemoryFile strips brackets from a single-element bracket cite_signal', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'one-bracket.md', {
    name: 'one-bracket',
    description: 'd',
    cite_signals: '[MAGIC_SIGNAL_X]',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.deepEqual(memories[0].citeSignals, ['MAGIC_SIGNAL_X']);
});

// --- GH-559 Task 1: behavior_signals frontmatter normalization ---
// Mirrors the cite_signals coverage above across the four YAML shapes
// memory-store must normalize identically to cite_signals:
//   1. bracket-array  (`[a, b, c]`)
//   2. inline comma list (`a, b, c`)
//   3. single scalar (`solo`)
//   4. single-bracket scalar (`[X]`)
// All four assert a normalized `behaviorSignals` string array on the
// loaded memory; the raw bracket-array literal must never leak through.

test('readMemoryFile forwards behavior_signals bracket-array to top-level behaviorSignals', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'beh-bracket.md', {
    name: 'beh-bracket',
    description: 'd',
    behavior_signals: '[alpha, beta, gamma]',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].behaviorSignals, ['alpha', 'beta', 'gamma']);
});

test('readMemoryFile splits inline comma-separated behavior_signals into tokens', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'beh-csv.md', {
    name: 'beh-csv',
    description: 'd',
    behavior_signals: 'Button, packages/ui, @app/foo',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.deepEqual(memories[0].behaviorSignals, ['Button', 'packages/ui', '@app/foo']);
});

test('readMemoryFile keeps a single scalar behavior_signal as one token', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'beh-solo.md', {
    name: 'beh-solo',
    description: 'd',
    behavior_signals: 'solo',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.deepEqual(memories[0].behaviorSignals, ['solo']);
});

test('readMemoryFile strips brackets from a single-element bracket behavior_signal', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'beh-one-bracket.md', {
    name: 'beh-one-bracket',
    description: 'd',
    behavior_signals: '[MAGIC_BEHAVIOR_X]',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.deepEqual(memories[0].behaviorSignals, ['MAGIC_BEHAVIOR_X']);
});

test('readMemoryFile top-level behaviorSignals is undefined when field absent', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'beh-absent.md', {
    name: 'beh-absent',
    description: 'd',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories[0].behaviorSignals, undefined);
});

// --- Top-level comma splitting: regex constructs must not shatter list items ---

test('toList keeps a trigger_pretool regex containing {1,3} as ONE spec', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'quant.md', {
    name: 'quant',
    description: 'd',
    events: 'PreToolUse',
    trigger_pretool: 'Bash:foo{1,3}bar',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.deepEqual(memories[0].triggerPretool, ['Bash:foo{1,3}bar']);
});

test('bracket-list trigger_pretool_content with nested {2,4} splits into exactly 2 patterns', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'bracket-quant.md', {
    name: 'bracket-quant',
    description: 'd',
    events: 'PreToolUse',
    trigger_pretool: 'Edit:',
    trigger_pretool_content: '[colou?r{2,4}, \\bfoo\\b]',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.deepEqual(memories[0].triggerPretoolContent, ['colou?r{2,4}', '\\bfoo\\b']);
});

test('plain comma-separated trigger_pretool still splits into 2 specs', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'plain-csv.md', {
    name: 'plain-csv',
    description: 'd',
    events: 'PreToolUse',
    trigger_pretool: 'Bash:git, Edit:x',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.deepEqual(memories[0].triggerPretool, ['Bash:git', 'Edit:x']);
});

test('toList does not split on commas inside character classes or groups', () => {
  const { toList } = require('../memory-store');
  assert.deepEqual(toList('Bash:x[a,b]y'), ['Bash:x[a,b]y']);
  assert.deepEqual(toList('Bash:(a,b)c'), ['Bash:(a,b)c']);
  assert.deepEqual(toList('a\\,b'), ['a\\,b']);
  // Plain csv identical to the naive split.
  assert.deepEqual(toList('a, b, c'), ['a', 'b', 'c']);
});

// --- YAML block-list frontmatter (previously silently dropped) ---

test('parseFrontmatter supports YAML block-list trigger_pretool', () => {
  const { storeDir } = makeTempStore();
  const raw = [
    '---',
    'name: block-list-mem',
    'description: d',
    'events: PreToolUse',
    'trigger_pretool:',
    '  - Bash:git\\s+push',
    '  - Edit:foo',
    'inject: full',
    '---',
    'body',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(storeDir, 'block-list-mem.md'), raw);

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].triggerPretool, ['Bash:git\\s+push', 'Edit:foo']);
  assert.deepEqual(memories[0].events, ['PreToolUse']);
});

test('parseFrontmatter supports YAML block-list events', () => {
  const { storeDir } = makeTempStore();
  const raw = [
    '---',
    'name: block-events-mem',
    'description: d',
    'events:',
    '',
    '  - UserPromptSubmit',
    '  - PreToolUse',
    'trigger_prompt: \\bdeploy\\b',
    'trigger_pretool: Bash:git',
    '---',
    'body',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(storeDir, 'block-events-mem.md'), raw);

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].events, ['UserPromptSubmit', 'PreToolUse']);
  assert.deepEqual(memories[0].triggerPretool, ['Bash:git']);
});

test('parseFrontmatter block-list items are NOT comma-split (regex commas survive)', () => {
  const { parseFrontmatter } = require('../memory-store');
  const raw = [
    '---',
    'trigger_pretool_content:',
    '  - colou?r{2,4}',
    '  - "\\bfoo\\b"',
    '---',
    'body',
  ].join('\n');
  const { meta } = parseFrontmatter(raw);
  assert.deepEqual(meta.trigger_pretool_content, ['colou?r{2,4}', '\\bfoo\\b']);
});

// --- getProjectName: linked git worktrees must resolve to the MAIN repo name ---

test('getProjectName resolves the main repo name from inside a linked worktree', (t) => {
  const { execSync } = require('node:child_process');
  const { getProjectName } = require('../memory-store');

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-worktree-name-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const repo = path.join(base, 'main-repo-name');
  const worktree = path.join(base, 'main-repo-name-GH-123');
  const run = (cmd, cwd) =>
    execSync(cmd, { cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'seed.txt'), 'seed\n');
  run('git init -q -b main', repo);
  run('git add seed.txt', repo);
  run('git -c user.email=t@t -c user.name=t commit -q -m init', repo);
  run(`git worktree add -q ${JSON.stringify(worktree)} -b gh-123`, repo);

  // From the main checkout the name is unchanged…
  assert.equal(getProjectName(repo), 'main-repo-name');
  // …and from inside the linked worktree it must be the MAIN repo name, not
  // the worktree directory basename (which would create a divergent global store).
  assert.equal(getProjectName(worktree), 'main-repo-name');
});

test('getProjectName falls back to basename(cwd) outside any git repo', () => {
  const { getProjectName } = require('../memory-store');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-no-git-'));
  const sub = path.join(dir, 'plain-project');
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(getProjectName(sub), 'plain-project');
});
