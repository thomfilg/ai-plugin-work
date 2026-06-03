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
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'test' })
  );
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
