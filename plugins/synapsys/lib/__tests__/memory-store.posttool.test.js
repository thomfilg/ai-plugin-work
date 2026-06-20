'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listMemoriesFromStore } = require('../memory-store');

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-posttool-'));
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

const store = (storeDir) => ({ kind: 'local', dir: storeDir, projectName: 'test' });

// P0-5a — readMemoryFile parses the three trigger_posttool_* frontmatter fields.

test('readMemoryFile parses trigger_posttool_content/_not as arrays and trigger_posttool_exit as scalar', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'net-error.md', {
    name: 'net-error',
    description: 'd',
    trigger_posttool_content: 'ENOTFOUND',
    trigger_posttool_content_not: 'warning',
    trigger_posttool_exit: 'nonzero',
  });

  const memories = listMemoriesFromStore(store(storeDir));
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].triggerPosttoolContent, ['ENOTFOUND']);
  assert.deepEqual(memories[0].triggerPosttoolContentNot, ['warning']);
  assert.equal(memories[0].triggerPosttoolExit, 'nonzero');
});

// Bracket YAML-flow lists must split into separate patterns (BRACKET_LIST_KEYS),
// matching trigger_pretool_content — not stay one string that toList shreds into
// invalid regex fragments like "[alpha" / "beta]".

test('readMemoryFile parses bracketed trigger_posttool_content/_not as separate patterns', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'bracketed.md', {
    name: 'bracketed',
    description: 'd',
    trigger_posttool_content: '[alpha, beta]',
    trigger_posttool_content_not: '[gamma, delta]',
  });

  const memories = listMemoriesFromStore(store(storeDir));
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].triggerPosttoolContent, ['alpha', 'beta']);
  assert.deepEqual(memories[0].triggerPosttoolContentNot, ['gamma', 'delta']);
});

// C-3 — absent fields default to empty arrays / null (forward-only, existing memories unchanged).

test('readMemoryFile yields [] / [] / null when the posttool fields are absent', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'no-fields.md', {
    name: 'no-fields',
    description: 'd',
  });

  const memories = listMemoriesFromStore(store(storeDir));
  assert.equal(memories.length, 1);
  assert.deepEqual(memories[0].triggerPosttoolContent, []);
  assert.deepEqual(memories[0].triggerPosttoolContentNot, []);
  assert.equal(memories[0].triggerPosttoolExit, null);
});

// Exit scalar must preserve 0 and "zero" rather than coercing to null.

test('readMemoryFile preserves trigger_posttool_exit numeric 0 and string "zero"', () => {
  const { storeDir } = makeTempStore();
  writeMemory(storeDir, 'exit-zero.md', {
    name: 'exit-zero',
    description: 'd',
    trigger_posttool_exit: 0,
  });
  writeMemory(storeDir, 'exit-zero-word.md', {
    name: 'exit-zero-word',
    description: 'd',
    trigger_posttool_exit: 'zero',
  });

  const memories = listMemoriesFromStore(store(storeDir));
  const byName = Object.fromEntries(memories.map((m) => [m.name, m]));
  assert.equal(byName['exit-zero'].triggerPosttoolExit, '0');
  assert.equal(byName['exit-zero-word'].triggerPosttoolExit, 'zero');
});

// cursor[bot] Medium — a PRESENT-but-EMPTY trigger_posttool_exit must normalize
// to null (no exit gate), NOT '' (which downstream coerces Number('')===0 and
// silently success-only-gates). Matches the R11 lint rule's empty == non-targeting.

test('readMemoryFile normalizes an empty trigger_posttool_exit to null (no exit gate)', () => {
  const { storeDir } = makeTempStore();
  // Trailing space after the colon yields an empty-string value from the parser.
  writeMemory(storeDir, 'exit-empty.md', {
    name: 'exit-empty',
    description: 'd',
    trigger_posttool_exit: '',
  });

  const memories = listMemoriesFromStore(store(storeDir));
  assert.equal(memories.length, 1);
  assert.equal(memories[0].triggerPosttoolExit, null);
  assert.notEqual(memories[0].triggerPosttoolExit, '');
});
