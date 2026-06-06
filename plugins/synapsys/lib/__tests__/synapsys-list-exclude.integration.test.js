'use strict';

/**
 * Tests for `plugins/synapsys/scripts/synapsys-list.js` (GH-510 Task 3).
 *
 * Task 3 RED — synapsys-list must surface exclude rules in JSON + verbose
 * output. Covers R5 + Gherkin "synapsys:list verbose output surfaces exclude
 * rules" row.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIST_SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'synapsys-list.js');

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-list-exclude-'));
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

function runList(cwd, args) {
  return spawnSync(
    process.execPath,
    [LIST_SCRIPT, `--cwd=${cwd}`, '--no-color', ...args],
    { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } }
  );
}

test('synapsys-list --json includes excludePrompt, excludePretool, excludePreset per memory', () => {
  const { cwd, storeDir } = makeTempStore();
  writeMemory(storeDir, 'ex.md', {
    name: 'ex',
    description: 'd',
    trigger_prompt: '\\bticket\\b',
    exclude_prompt: '\\bgit\\s+merge\\b',
    exclude_preset: 'ci-monitor',
  });

  const result = runList(cwd, ['--json']);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  assert.ok(Array.isArray(payload.memories), 'payload.memories must be an array');
  const mem = payload.memories.find((m) => m.name === 'ex');
  assert.ok(mem, 'memory "ex" must appear in JSON output');
  assert.equal(mem.excludePrompt, '\\bgit\\s+merge\\b', 'excludePrompt must be emitted in JSON');
  assert.deepEqual(mem.excludePretool, [], 'excludePretool must default to [] in JSON');
  assert.deepEqual(mem.excludePreset, ['ci-monitor'], 'excludePreset must be emitted in JSON');
});

test('synapsys-list --verbose prints exclude_prompt and exclude_preset labeled rows', () => {
  const { cwd, storeDir } = makeTempStore();
  writeMemory(storeDir, 'ex.md', {
    name: 'ex',
    description: 'd',
    trigger_prompt: '\\bticket\\b',
    exclude_prompt: '\\bgit\\s+merge\\b',
    exclude_preset: 'ci-monitor',
  });

  const result = runList(cwd, ['--verbose']);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert.match(
    result.stdout,
    /exclude_prompt:.*\\bgit\\s\+merge\\b/,
    'verbose output must contain an "exclude_prompt:" row with the regex'
  );
  assert.match(
    result.stdout,
    /exclude_preset:.*ci-monitor/,
    'verbose output must contain an "exclude_preset:" row listing the preset name'
  );
});

test('synapsys-list --verbose omits exclude rows for memories without exclude fields', () => {
  const { cwd, storeDir } = makeTempStore();
  writeMemory(storeDir, 'plain.md', {
    name: 'plain',
    description: 'd',
    trigger_prompt: '\\bticket\\b',
  });

  const result = runList(cwd, ['--verbose']);
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
  assert.doesNotMatch(
    result.stdout,
    /exclude_prompt:/,
    'verbose output must NOT contain "exclude_prompt:" when the field is empty'
  );
  assert.doesNotMatch(
    result.stdout,
    /exclude_preset:/,
    'verbose output must NOT contain "exclude_preset:" when the field is empty'
  );
  assert.doesNotMatch(
    result.stdout,
    /exclude_pretool:/,
    'verbose output must NOT contain "exclude_pretool:" when the field is empty'
  );
});
