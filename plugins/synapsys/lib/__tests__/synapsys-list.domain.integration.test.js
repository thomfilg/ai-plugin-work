'use strict';

// RED phase — Task 9 (GH-513): synapsys-list CLI integration.
//
// Spawns the real `synapsys-list.js` against a tmpdir memory store with both
// domain-tagged and untagged fixtures and asserts rendered stdout:
//   - tagged memories include a `domain:` line with the values
//   - untagged memories do NOT include a `domain:` line

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LIST_SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'synapsys-list.js');

function makeTempStore() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-list-domain-'));
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), JSON.stringify({ projectName: 'test' }));
  return { cwd, storeDir };
}

function writeMemory(storeDir, fileName, frontmatter) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(path.join(storeDir, fileName), `---\n${fm}\n---\nbody text\n`);
}

function runList(cwd, extraArgs = []) {
  return spawnSync(process.execPath, [LIST_SCRIPT, `--cwd=${cwd}`, '--no-color', ...extraArgs], {
    encoding: 'utf8',
  });
}

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

test('synapsys-list CLI: domain-tagged memory shows `domain:` line in stdout', () => {
  const { cwd, storeDir } = makeTempStore();
  writeMemory(storeDir, 'tagged.md', {
    name: 'tagged-mem',
    description: 'tagged with e2e',
    trigger_prompt: '/\\btagged\\b/',
    domain: 'e2e',
  });

  const res = runList(cwd);
  assert.equal(res.status, 0, `exit 0, stderr=${res.stderr}`);
  const out = stripAnsi(res.stdout);
  assert.match(out, /tagged-mem/);
  assert.match(out, /domain:\s*e2e\b/);
});

test('synapsys-list CLI: untagged memory does NOT show a `domain:` line', () => {
  const { cwd, storeDir } = makeTempStore();
  writeMemory(storeDir, 'untagged.md', {
    name: 'untagged-mem',
    description: 'no domain field',
    trigger_prompt: '/\\buntagged\\b/',
  });

  const res = runList(cwd);
  assert.equal(res.status, 0, `exit 0, stderr=${res.stderr}`);
  const out = stripAnsi(res.stdout);
  assert.match(out, /untagged-mem/);
  // Slice to the untagged-mem section; there should be no `domain:` line
  // attached to it (and no domain: line at all, since it's the only memory).
  assert.doesNotMatch(out, /domain:/);
});

test('synapsys-list CLI: multi-domain renders comma-joined values', () => {
  const { cwd, storeDir } = makeTempStore();
  writeMemory(storeDir, 'multi.md', {
    name: 'multi-mem',
    description: 'multi-domain',
    trigger_prompt: '/\\bmulti\\b/',
    domain: '[e2e, git]',
  });

  const res = runList(cwd);
  assert.equal(res.status, 0, `exit 0, stderr=${res.stderr}`);
  const out = stripAnsi(res.stdout);
  assert.match(out, /multi-mem/);
  assert.match(out, /domain:\s*e2e,\s*git\b/);
});

test('synapsys-list CLI: mixed store — tagged shows domain, untagged does not', () => {
  const { cwd, storeDir } = makeTempStore();
  writeMemory(storeDir, 'a-tagged.md', {
    name: 'a-tagged',
    description: 'tagged',
    trigger_prompt: '/\\btag\\b/',
    domain: 'git',
  });
  writeMemory(storeDir, 'b-untagged.md', {
    name: 'b-untagged',
    description: 'no domain',
    trigger_prompt: '/\\bnodom\\b/',
  });

  const res = runList(cwd);
  assert.equal(res.status, 0, `exit 0, stderr=${res.stderr}`);
  const out = stripAnsi(res.stdout);

  // Slice the section for each memory based on the name marker.
  const aIdx = out.indexOf('a-tagged');
  const bIdx = out.indexOf('b-untagged');
  assert.ok(aIdx >= 0 && bIdx > aIdx, 'both memories rendered in order');
  const aSection = out.slice(aIdx, bIdx);
  const bSection = out.slice(bIdx);

  assert.match(aSection, /domain:\s*git\b/, 'a-tagged section has domain line');
  assert.doesNotMatch(bSection, /domain:/, 'b-untagged section has no domain line');
});

test('synapsys-list CLI --json includes `domain` field per memory', () => {
  const { cwd, storeDir } = makeTempStore();
  writeMemory(storeDir, 'tagged.md', {
    name: 'tagged-mem',
    description: 'tagged',
    domain: 'e2e',
  });
  writeMemory(storeDir, 'untagged.md', {
    name: 'untagged-mem',
    description: 'untagged',
  });

  const res = runList(cwd, ['--json']);
  assert.equal(res.status, 0, `exit 0, stderr=${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  const tagged = parsed.memories.find((m) => m.name === 'tagged-mem');
  const untagged = parsed.memories.find((m) => m.name === 'untagged-mem');
  assert.ok(tagged, 'tagged-mem present in JSON');
  assert.ok(untagged, 'untagged-mem present in JSON');
  assert.deepEqual(tagged.domain, ['e2e']);
  assert.deepEqual(untagged.domain, []);
});
