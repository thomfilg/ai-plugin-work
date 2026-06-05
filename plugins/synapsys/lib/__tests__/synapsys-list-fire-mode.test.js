'use strict';

/**
 * P0 #7 synapsys:list shows fire_mode and injectedCount
 *
 * RED-phase tests for Task 4 (GH-511). These exercise `synapsys-list.js`
 * end-to-end via spawnSync so we observe the actual CLI output (compact
 * text + --json + --verbose) and the integration with the per-session
 * inject-ledger.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'synapsys-list.js');

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-list-firemode-'));
  const storeDir = path.join(dir, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ projectName: 'firemode-test' })
  );
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-list-home-'));
  return { cwd: dir, storeDir, home };
}

function writeMemory(storeDir, fileName, frontmatter) {
  const fm = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  fs.writeFileSync(path.join(storeDir, fileName), `---\n${fm}\n---\nbody\n`);
}

function seedLedger(home, sessionId, memoriesEntry) {
  const dir = path.join(home, '.claude', 'synapsys', '.session');
  fs.mkdirSync(dir, { recursive: true });
  // Pin the resolved session id by writing `.current`.
  fs.writeFileSync(path.join(dir, '.current'), sessionId);
  fs.writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({
      createdAt: new Date().toISOString(),
      sessionId,
      memories: memoriesEntry,
    })
  );
}

function runList(cwd, home, extraArgs) {
  const result = spawnSync(process.execPath, [SCRIPT, `--cwd=${cwd}`, '--no-color', ...extraArgs], {
    env: { ...process.env, HOME: home, NO_COLOR: '1' },
    encoding: 'utf8',
  });
  return result;
}

test('P0 #7 synapsys:list shows fire_mode and injectedCount — --json payload includes fireMode, fireCadence, injectedCount from ledger', () => {
  const { cwd, storeDir, home } = makeTempStore();
  writeMemory(storeDir, 'cadenced.md', {
    name: 'cadenced',
    description: 'd',
    fire_mode: 'occasionally',
    fire_cadence: 7,
  });

  const sessionId = 'test-session-cadenced';
  seedLedger(home, sessionId, {
    cadenced: { injectedCount: 4, lastFullInjectAt: 1 },
  });

  const result = runList(cwd, home, ['--json']);
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const payload = JSON.parse(result.stdout);
  const mem = payload.memories.find((m) => m.name === 'cadenced');
  assert.ok(mem, 'memory present in payload');
  assert.equal(mem.fireMode, 'occasionally');
  assert.equal(mem.fireCadence, 7);
  assert.equal(mem.injectedCount, 4);
  // Pre-existing keys preserved (additive change).
  assert.equal(mem.description, 'd');
  assert.ok(Array.isArray(mem.events));
});

test('P0 #7 synapsys:list shows fire_mode and injectedCount — compact + verbose text output for always memory shows A indicator and fire/count line', () => {
  const { cwd, storeDir, home } = makeTempStore();
  writeMemory(storeDir, 'safety.md', {
    name: 'safety',
    description: 'critical',
    fire_mode: 'always',
  });

  const sessionId = 'test-session-safety';
  seedLedger(home, sessionId, {
    safety: { injectedCount: 3, lastFullInjectAt: 3 },
  });

  // Compact
  const compact = runList(cwd, home, []);
  assert.equal(compact.status, 0, `stderr: ${compact.stderr}`);
  // Find the row line that has the name.
  const compactRow = compact.stdout
    .split('\n')
    .find((l) => l.includes('safety') && !l.includes('critical'));
  assert.ok(compactRow, `expected a row line containing "safety", got:\n${compact.stdout}`);
  assert.match(compactRow, /\bA\b/, `compact row should include A indicator: ${compactRow}`);

  // Verbose
  const verbose = runList(cwd, home, ['--verbose']);
  assert.equal(verbose.status, 0, `stderr: ${verbose.stderr}`);
  assert.match(
    verbose.stdout,
    /fire:\s*always\s+count:\s*3/,
    `verbose output should contain "fire: always   count: 3"`
  );
});
