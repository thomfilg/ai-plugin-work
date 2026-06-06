'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listMemoriesFromStore } = require('../memory-store');

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-memstore-exclude-'));
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

function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const ret = fn();
    return { ret, stderr: chunks.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

// --- 1.2.1 RED assertions ---

test('readMemoryFile parses exclude_prompt, exclude_pretool, exclude_preset into memory object', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'ex.md', {
    name: 'ex',
    description: 'd',
    exclude_prompt: '\\bfoo\\b',
    exclude_pretool: 'Bash:bar',
    exclude_preset: 'git-ops',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  const m = memories[0];
  assert.equal(m.excludePrompt, '\\bfoo\\b');
  assert.deepEqual(m.excludePretool, ['Bash:bar']);
  assert.deepEqual(m.excludePreset, ['git-ops']);
  assert.ok(Array.isArray(m.excludeResolved), 'excludeResolved must be an array');
  // Must contain the explicit excludePrompt regex body.
  assert.ok(
    m.excludeResolved.includes('\\bfoo\\b'),
    'excludeResolved must include excludePrompt regex body'
  );
  // Must contain at least the git-ops preset resolution (non-empty string).
  assert.ok(
    m.excludeResolved.length >= 2,
    'excludeResolved must include at least the prompt body and the git-ops preset'
  );
});

test('unknown preset name in exclude_preset emits one stderr warning at load time', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'unk.md', {
    name: 'unk',
    description: 'd',
    exclude_preset: '[git-ops, does-not-exist]',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const { ret: memories, stderr } = captureStderr(() => listMemoriesFromStore(store));
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].excludePreset, ['git-ops', 'does-not-exist']);
  assert.match(stderr, /does-not-exist/);
});

test('memory without any exclude_* field defaults to empty values (backwards compat)', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'plain.md', {
    name: 'plain',
    description: 'd',
  });

  const store = { kind: 'local', dir: storeDir, projectName: 'test' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1);
  const m = memories[0];
  assert.equal(m.excludePrompt, '');
  assert.deepEqual(m.excludePretool, []);
  assert.deepEqual(m.excludePreset, []);
  assert.deepEqual(m.excludeResolved, []);
});
