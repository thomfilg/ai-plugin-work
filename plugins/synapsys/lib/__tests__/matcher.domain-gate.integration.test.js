'use strict';

// RED phase — Task 7 (GH-513) integration:
// Compose readMemoryFile/listMemories (Task 1) -> selectForEvent (this task)
// over a tmpdir fixture of domain-tagged + untagged memory files. Asserts
// the full pipeline yields the expected domain-mismatch exclusions and
// backward-compat passes through (R4, R10, AC1, AC2).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listMemories } = require(path.resolve(__dirname, '..', 'memory-store'));
const { selectForEvent } = require(path.resolve(__dirname, '..', 'matcher'));

function makeStore() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-domain-gate-int-'));
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'gh-513-domain-gate' })
  );
  return { cwd, storeDir };
}

function write(storeDir, name, body) {
  fs.writeFileSync(path.join(storeDir, name), body);
}

test('Memory with non-overlapping domain is skipped even when trigger matches (end-to-end)', () => {
  const { cwd, storeDir } = makeStore();

  // (a) untagged universal memory — fires on trigger regardless of active set
  write(
    storeDir,
    'universal.md',
    '---\nname: universal\ndescription: d\nevents: UserPromptSubmit\ntrigger_prompt: \\bdeploy\\b\n---\nbody\n'
  );

  // (b) git-tagged memory — should be skipped when active=[e2e]
  write(
    storeDir,
    'git-tagged.md',
    '---\nname: git-tagged\ndescription: d\nevents: UserPromptSubmit\ndomain: git\ntrigger_prompt: \\bdeploy\\b\n---\nbody\n'
  );

  // (c) e2e-tagged memory — should fire when active=[e2e]
  write(
    storeDir,
    'e2e-tagged.md',
    '---\nname: e2e-tagged\ndescription: d\nevents: UserPromptSubmit\ndomain: e2e\ntrigger_prompt: \\bdeploy\\b\n---\nbody\n'
  );

  const memories = listMemories(cwd);
  // Sanity: all three loaded
  const names = memories.map((m) => m.name).sort();
  assert.ok(names.includes('universal'), `expected 'universal' in ${names}`);
  assert.ok(names.includes('git-tagged'), `expected 'git-tagged' in ${names}`);
  assert.ok(names.includes('e2e-tagged'), `expected 'e2e-tagged' in ${names}`);

  // With activeDomains = {e2e}: git-tagged is excluded (domain-mismatch),
  // e2e-tagged fires (overlap), universal fires (no domain).
  const picked = selectForEvent(
    memories,
    'UserPromptSubmit',
    { prompt: 'please deploy now' },
    { activeDomains: new Set(['e2e']) }
  );
  const pickedNames = picked.map((m) => m.name).sort();
  assert.deepEqual(
    pickedNames,
    ['e2e-tagged', 'universal'],
    `expected only universal+e2e-tagged; got ${pickedNames}`
  );
});

test('Backward compat: omitting opts.activeDomains leaves domain-tagged memories firing on trigger (AC1)', () => {
  const { cwd, storeDir } = makeStore();

  write(
    storeDir,
    'git-tagged.md',
    '---\nname: git-tagged\ndescription: d\nevents: UserPromptSubmit\ndomain: git\ntrigger_prompt: \\bdeploy\\b\n---\nbody\n'
  );
  write(
    storeDir,
    'universal.md',
    '---\nname: universal\ndescription: d\nevents: UserPromptSubmit\ntrigger_prompt: \\bdeploy\\b\n---\nbody\n'
  );

  const memories = listMemories(cwd);

  // No 4th arg
  const picked = selectForEvent(memories, 'UserPromptSubmit', { prompt: 'please deploy now' });
  const pickedNames = picked.map((m) => m.name).sort();
  assert.deepEqual(pickedNames, ['git-tagged', 'universal']);
});
