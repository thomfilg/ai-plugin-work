'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listMemoriesFromStore, parseFrontmatter } = require('../memory-store');

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-memstore-'));
  const storeDir = path.join(dir, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'test' })
  );
  return { cwd: dir, storeDir };
}

function writeMemory(storeDir, name, frontmatter) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const content = `---\n${fm}\n---\nbody\n`;
  fs.writeFileSync(path.join(storeDir, name), content);
}

// --- Task 1: readMemoryFile parses trigger_pretool_content_not ---

test('readMemoryFile parses trigger_pretool_content_not as a list when present', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'neg.md', {
    name: 'neg',
    description: 'd',
    trigger_pretool_content_not: '[foo, bar]',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].triggerPretoolContentNot, ['foo', 'bar']);
});

test('readMemoryFile yields triggerPretoolContentNot: [] when field absent', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'absent.md', {
    name: 'absent',
    description: 'd',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].triggerPretoolContentNot, []);
});

test('readMemoryFile yields triggerPretoolContentNot: [] when field is empty bracket array', () => {
  const { storeDir } = makeTempStore();
  // Empty array form — coerceFrontmatterValue treats `[]` without comma as a string;
  // toList must still normalize to [].
  writeMemory(storeDir, 'empty.md', {
    name: 'empty',
    description: 'd',
    trigger_pretool_content_not: '',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].triggerPretoolContentNot, []);
});

test('existing triggerPretoolContent parsing behavior unchanged (regression)', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'pos.md', {
    name: 'pos',
    description: 'd',
    trigger_pretool_content: '[alpha, beta]',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].triggerPretoolContent, ['alpha', 'beta']);
  assert.deepEqual(memories[0].triggerPretoolContentNot, []);
});

test('parseFrontmatter exposes raw trigger_pretool_content_not value', () => {
  const { meta } = parseFrontmatter(
    '---\ntrigger_pretool_content_not: [x, y]\n---\nbody\n'
  );
  assert.deepEqual(meta.trigger_pretool_content_not, ['x', 'y']);
});
