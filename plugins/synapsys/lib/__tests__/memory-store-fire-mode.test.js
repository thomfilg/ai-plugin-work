'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listMemoriesFromStore } = require('../memory-store');

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-firemode-'));
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

function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}

// --- P0 #1 default — memory without fire_mode behaves as once ---

test('P0 #1 default: memory without fire_mode yields fireMode=once, fireCadence=5, no warning', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'defaults.md', {
    name: 'defaults',
    description: 'd',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  let memories;
  const stderr = captureStderr(() => {
    memories = listMemoriesFromStore(store);
  });

  assert.equal(memories.length, 1);
  assert.equal(memories[0].fireMode, 'once');
  assert.equal(memories[0].fireCadence, 5);
  assert.equal(stderr, '', 'no stderr warning when keys are omitted');
});

test('readMemoryFile accepts always / once / occasionally as valid fire_mode values', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'a.md', { name: 'a', description: 'd', fire_mode: 'always' });
  writeMemory(storeDir, 'b.md', { name: 'b', description: 'd', fire_mode: 'once' });
  writeMemory(storeDir, 'c.md', {
    name: 'c',
    description: 'd',
    fire_mode: 'occasionally',
    fire_cadence: 3,
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  let memories;
  const stderr = captureStderr(() => {
    memories = listMemoriesFromStore(store);
  });
  const byName = Object.fromEntries(memories.map((m) => [m.name, m]));

  assert.equal(byName.a.fireMode, 'always');
  assert.equal(byName.a.fireCadence, 5);
  assert.equal(byName.b.fireMode, 'once');
  assert.equal(byName.b.fireCadence, 5);
  assert.equal(byName.c.fireMode, 'occasionally');
  assert.equal(byName.c.fireCadence, 3);
  assert.equal(stderr, '', 'no warning for valid values');
});

// --- P0 #1 invalid value falls back to once with stderr warning ---

test('P0 #1 invalid fire_mode falls back to once and writes a stderr warning naming the memory and value', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'bogus.md', {
    name: 'bogus',
    description: 'd',
    fire_mode: 'sometimes',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  let memories;
  const stderr = captureStderr(() => {
    memories = listMemoriesFromStore(store);
  });

  assert.equal(memories.length, 1);
  assert.equal(memories[0].fireMode, 'once', 'invalid fire_mode must default to once');
  assert.equal(memories[0].fireCadence, 5);
  assert.match(stderr, /bogus/, 'warning mentions the memory name');
  assert.match(stderr, /sometimes/, 'warning mentions the offending value');
});

test('invalid fire_cadence (non-integer / 0 / negative) falls back to 5 with stderr warning', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'zero.md', {
    name: 'zero',
    description: 'd',
    fire_mode: 'occasionally',
    fire_cadence: 0,
  });
  writeMemory(storeDir, 'neg.md', {
    name: 'neg',
    description: 'd',
    fire_mode: 'occasionally',
    fire_cadence: -3,
  });
  writeMemory(storeDir, 'nan.md', {
    name: 'nan',
    description: 'd',
    fire_mode: 'occasionally',
    fire_cadence: 'banana',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  let memories;
  const stderr = captureStderr(() => {
    memories = listMemoriesFromStore(store);
  });
  const byName = Object.fromEntries(memories.map((m) => [m.name, m]));

  assert.equal(byName.zero.fireCadence, 5);
  assert.equal(byName.neg.fireCadence, 5);
  assert.equal(byName.nan.fireCadence, 5);
  assert.match(stderr, /zero/);
  assert.match(stderr, /neg/);
  assert.match(stderr, /nan/);
});

test('fire_mode and fire_cadence parsing does not alter existing inject/trigger fields', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'mix.md', {
    name: 'mix',
    description: 'd',
    inject: 'full',
    trigger_pretool: '[Bash, Write]',
    fire_mode: 'always',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].inject, 'full');
  assert.deepEqual(memories[0].triggerPretool, ['Bash', 'Write']);
  assert.equal(memories[0].fireMode, 'always');
});
