'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listMemoriesFromStore } = require('../memory-store');

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-stopresp-'));
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

// P0 #1 — Frontmatter parser surfaces trigger_stop_response on the memory object

test('readMemoryFile maps trigger_stop_response to triggerStopResponse when present', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'flaky.md', {
    name: 'flaky',
    description: 'd',
    trigger_stop_response: '"\\bflaky\\b"',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].triggerStopResponse, '\\bflaky\\b');
});

test('readMemoryFile yields triggerStopResponse === "" when field is absent', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'no-field.md', {
    name: 'no-field',
    description: 'd',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  assert.equal(memories[0].triggerStopResponse, '');
});
