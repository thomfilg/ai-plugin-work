'use strict';

// RED phase — Task 1 (GH-513): Extend readMemoryFile with `domain` frontmatter.
//
// These tests assert the four shapes the AC spells out (missing/bare/list/quoted)
// plus a backward-compat snapshot over a memory without `domain:` to prove no
// other field is perturbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listMemoriesFromStore } = require('../memory-store');

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-domain-unit-'));
  const storeDir = path.join(dir, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), JSON.stringify({ projectName: 'test' }));
  return { cwd: dir, storeDir };
}

function writeMemory(storeDir, name, frontmatter) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const content = `---\n${fm}\n---\nbody\n`;
  fs.writeFileSync(path.join(storeDir, name), content);
}

function readOne(storeDir, fileName) {
  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  return memories.find((m) => path.basename(m.file) === fileName);
}

test('readMemoryFile: missing `domain:` defaults to []', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'no-domain.md', {
    name: 'no-domain',
    description: 'd',
    trigger_prompt: '/\\bfoo\\b/',
  });
  const m = readOne(storeDir, 'no-domain.md');
  assert.ok(m, 'memory loaded');
  assert.deepEqual(m.domain, []);
});

test('readMemoryFile: bare string `domain: e2e` normalizes to ["e2e"]', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'bare.md', {
    name: 'bare',
    description: 'd',
    domain: 'e2e',
  });
  const m = readOne(storeDir, 'bare.md');
  assert.ok(m);
  assert.deepEqual(m.domain, ['e2e']);
});

test('readMemoryFile: bracket list `domain: [e2e, git]` normalizes to ["e2e","git"]', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'list.md', {
    name: 'list',
    description: 'd',
    domain: '[e2e, git]',
  });
  const m = readOne(storeDir, 'list.md');
  assert.ok(m);
  assert.deepEqual(m.domain, ['e2e', 'git']);
});

test('readMemoryFile: single-item bracket list `domain: [git]` normalizes to ["git"]', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'single.md', {
    name: 'single',
    description: 'd',
    domain: '[git]',
  });
  const m = readOne(storeDir, 'single.md');
  assert.ok(m);
  assert.deepEqual(m.domain, ['git']);
});

test('readMemoryFile: quoted value preserves casing/whitespace inside quotes', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'quoted.md', {
    name: 'quoted',
    description: 'd',
    domain: '"E2E:Local-Execution"',
  });
  const m = readOne(storeDir, 'quoted.md');
  assert.ok(m);
  // Mixed case preserved as authored; coerceFrontmatterValue strips outer quotes.
  assert.deepEqual(m.domain, ['E2E:Local-Execution']);
});

test('readMemoryFile: leaf+colon leaf value normalizes to single entry', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'leaf.md', {
    name: 'leaf',
    description: 'd',
    domain: 'e2e:flake-triage',
  });
  const m = readOne(storeDir, 'leaf.md');
  assert.ok(m);
  assert.deepEqual(m.domain, ['e2e:flake-triage']);
});

test('readMemoryFile: `trigger_prompt: [a-z0-9]` stays a string (regex char class, not a list)', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'tp-class.md', {
    name: 'tp-class',
    description: 'd',
    trigger_prompt: '[a-z0-9]',
  });
  const m = readOne(storeDir, 'tp-class.md');
  assert.ok(m);
  assert.equal(m.triggerPrompt, '[a-z0-9]');
});

test('readMemoryFile: `trigger_prompt: [0-9]` stays a string (digit char class, not a list)', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'tp-digits.md', {
    name: 'tp-digits',
    description: 'd',
    trigger_prompt: '[0-9]',
  });
  const m = readOne(storeDir, 'tp-digits.md');
  assert.ok(m);
  assert.equal(m.triggerPrompt, '[0-9]');
});

test('readMemoryFile: `domain: [git]` still normalizes to ["git"] (no regression on list-typed keys)', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'dom-git.md', {
    name: 'dom-git',
    description: 'd',
    domain: '[git]',
  });
  const m = readOne(storeDir, 'dom-git.md');
  assert.ok(m);
  assert.deepEqual(m.domain, ['git']);
});

test('readMemoryFile: backward-compat — memory without `domain:` round-trips with all other fields intact', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'compat.md', {
    name: 'compat-mem',
    description: 'desc',
    events: 'UserPromptSubmit',
    trigger_prompt: '/\\bcascade\\b/',
    trigger_pretool: '[Bash, Read]',
    trigger_pretool_content: '[alpha, beta]',
    trigger_pretool_content_not: '[gamma, delta]',
    inject: 'full',
  });
  const m = readOne(storeDir, 'compat.md');
  assert.ok(m);
  // domain defaulted
  assert.deepEqual(m.domain, []);
  // every other field preserved verbatim
  assert.equal(m.name, 'compat-mem');
  assert.equal(m.description, 'desc');
  assert.deepEqual(m.events, ['UserPromptSubmit']);
  assert.equal(m.triggerPrompt, '/\\bcascade\\b/');
  assert.deepEqual(m.triggerPretool, ['Bash', 'Read']);
  assert.deepEqual(m.triggerPretoolContent, ['alpha', 'beta']);
  assert.deepEqual(m.triggerPretoolContentNot, ['gamma', 'delta']);
  assert.equal(m.inject, 'full');
  assert.equal(m.disabled, false);
  assert.equal(m.expired, false);
});
