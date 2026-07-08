'use strict';

// RED phase — Task 1 (GH-513) integration:
// Scans a real on-disk plugin memory store through listMemories (the public
// end-to-end loader) and asserts every loaded record carries `domain: string[]`,
// whether defaulted or extracted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listMemories } = require('../memory-store');

function makeStore() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-domain-int-'));
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'gh-513-int' })
  );
  return { cwd, storeDir };
}

function write(storeDir, name, body) {
  fs.writeFileSync(path.join(storeDir, name), body);
}

test('listMemories: every loaded record has domain: string[] field (defaulted or extracted)', () => {
  const { cwd, storeDir } = makeStore();

  // (a) no domain — defaults to []
  write(
    storeDir,
    'plain.md',
    '---\nname: plain\ndescription: d\ntrigger_prompt: /\\bplain\\b/\n---\nbody\n'
  );

  // (b) bare string domain
  write(
    storeDir,
    'bare.md',
    '---\nname: bare\ndescription: d\ndomain: git\ntrigger_prompt: /\\bgit\\b/\n---\nbody\n'
  );

  // (c) bracket list domain
  write(
    storeDir,
    'multi.md',
    '---\nname: multi\ndescription: d\ndomain: [e2e:flake-triage, ci:failure-diagnosis]\n---\nbody\n'
  );

  // (d) leaf-only domain
  write(
    storeDir,
    'leaf.md',
    '---\nname: leaf\ndescription: d\ndomain: code-author:react\n---\nbody\n'
  );

  const memories = listMemories(cwd);
  assert.ok(memories.length >= 4, `expected ≥4 memories, got ${memories.length}`);

  for (const m of memories) {
    assert.ok(
      Array.isArray(m.domain),
      `memory ${m.name} (${m.file}) must expose domain as string[] (got ${typeof m.domain})`
    );
    for (const d of m.domain) {
      assert.equal(typeof d, 'string', `domain entry of ${m.name} must be string`);
    }
  }

  const byName = Object.fromEntries(memories.map((m) => [m.name, m]));
  assert.deepEqual(byName.plain.domain, []);
  assert.deepEqual(byName.bare.domain, ['git']);
  assert.deepEqual(byName.multi.domain, ['e2e:flake-triage', 'ci:failure-diagnosis']);
  assert.deepEqual(byName.leaf.domain, ['code-author:react']);
});
