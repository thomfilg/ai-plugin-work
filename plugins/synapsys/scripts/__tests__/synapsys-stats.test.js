'use strict';

/**
 * synapsys-stats — Behavior-changers section, refined Noise classification,
 * and `--changers-only` CLI flag (GH-559 Task 6).
 *
 * Covers gherkin scenarios:
 *   - synapsys-stats renders Behavior-changers section sorted by changed/fired ratio (AC9, R4)
 *   - Refined Noise classification excludes memories with changed > 0 (AC10, R5)
 *   - `--changers-only` flag suppresses other sections (R9)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '..', 'synapsys-stats.js');

function makeTempEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-stats-test-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-stats-test-cwd-'));
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ kind: 'worktree', projectName: 'test', schemaVersion: 1 })
  );
  const telDir = path.join(home, '.claude', 'synapsys', '.telemetry');
  fs.mkdirSync(telDir, { recursive: true });
  return { home, cwd, storeDir, telDir };
}

function writeMemory(storeDir, name, extraFm = '') {
  const fm = [
    '---',
    `name: ${name}`,
    'description: test memory.',
    'events: PreToolUse',
    'inject: full',
    extraFm,
    '---',
    '',
    'body',
    '',
  ]
    .filter(Boolean)
    .join('\n');
  fs.writeFileSync(path.join(storeDir, `${name}.md`), fm);
}

function writeEvents(telDir, sessionId, events) {
  const file = path.join(telDir, `${sessionId}.jsonl`);
  const lines = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.writeFileSync(file, lines);
}

function runStats(home, cwd, extraArgs = []) {
  const res = spawnSync(process.execPath, [SCRIPT, `--cwd=${cwd}`, '--last=30d', ...extraArgs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: '1',
      SYNAPSYS_DISABLE_HOME_STORES: '1',
    },
  });
  return { stdout: res.stdout || '', stderr: res.stderr || '', status: res.status };
}

test('synapsys-stats renders Behavior-changers section with columns and ratio-descending sort (AC9)', () => {
  const { home, cwd, storeDir, telDir } = makeTempEnv();
  writeMemory(storeDir, 'mem-a');
  writeMemory(storeDir, 'mem-b');
  writeMemory(storeDir, 'mem-c');
  writeEvents(telDir, 'sess1', [
    // mem-a: fired:10 cited:2 changed:5 -> ratio 0.50
    ...Array(10).fill({ event: 'fired', memory: 'mem-a' }),
    ...Array(2).fill({ event: 'cited', memory: 'mem-a' }),
    ...Array(5).fill({ event: 'behavior_changed', memory: 'mem-a' }),
    // mem-b: fired:10 cited:1 changed:8 -> ratio 0.80
    ...Array(10).fill({ event: 'fired', memory: 'mem-b' }),
    ...Array(1).fill({ event: 'cited', memory: 'mem-b' }),
    ...Array(8).fill({ event: 'behavior_changed', memory: 'mem-b' }),
    // mem-c: fired:10 cited:1 changed:1 -> ratio 0.10
    ...Array(10).fill({ event: 'fired', memory: 'mem-c' }),
    ...Array(1).fill({ event: 'cited', memory: 'mem-c' }),
    ...Array(1).fill({ event: 'behavior_changed', memory: 'mem-c' }),
  ]);

  const { stdout, status } = runStats(home, cwd);
  assert.equal(status, 0, `expected exit 0, got ${status}; stderr=...`);
  assert.match(
    stdout,
    /Behavior-changers/,
    `expected "Behavior-changers" section header.\n${stdout}`
  );
  assert.match(stdout, /fired/, 'expected "fired" column');
  assert.match(stdout, /cited/, 'expected "cited" column');
  assert.match(stdout, /changed/, 'expected "changed" column');
  assert.match(stdout, /verdict/, 'expected "verdict" column');

  // Extract the Behavior-changers block and verify row order: mem-b, mem-a, mem-c.
  const idx = stdout.indexOf('Behavior-changers');
  assert.ok(idx >= 0, 'Behavior-changers section must be present');
  const block = stdout.slice(idx);
  const posB = block.indexOf('mem-b');
  const posA = block.indexOf('mem-a');
  const posC = block.indexOf('mem-c');
  assert.ok(
    posB > 0 && posA > 0 && posC > 0,
    `all three memories must appear in Behavior-changers block.\n${block}`
  );
  assert.ok(posB < posA, `mem-b (ratio 0.80) must appear before mem-a (ratio 0.50).\n${block}`);
  assert.ok(posA < posC, `mem-a (ratio 0.50) must appear before mem-c (ratio 0.10).\n${block}`);
});

test('Refined Noise classification excludes memories with changed > 0 (AC10)', () => {
  const { home, cwd, storeDir, telDir } = makeTempEnv();
  writeMemory(storeDir, 'mem-x');
  writeMemory(storeDir, 'mem-y');
  writeEvents(telDir, 'sess1', [
    // mem-x: fired:15, cited:0, changed:3 -> NOT noise
    ...Array(15).fill({ event: 'fired', memory: 'mem-x' }),
    ...Array(3).fill({ event: 'behavior_changed', memory: 'mem-x' }),
    // mem-y: fired:15, cited:0, changed:0 -> IS noise
    ...Array(15).fill({ event: 'fired', memory: 'mem-y' }),
  ]);

  const { stdout, status } = runStats(home, cwd);
  assert.equal(status, 0);

  const noiseIdx = stdout.indexOf('Noise candidates');
  assert.ok(noiseIdx >= 0, 'Noise candidates section must exist');
  // Slice from Noise header until the next blank-line-section boundary.
  const afterNoise = stdout.slice(noiseIdx);
  const endIdx = afterNoise.indexOf('\nNever-fired');
  const noiseBlock = endIdx >= 0 ? afterNoise.slice(0, endIdx) : afterNoise;

  assert.doesNotMatch(
    noiseBlock,
    /mem-x/,
    `mem-x (changed:3) must NOT be in Noise.\n--- NOISE BLOCK ---\n${noiseBlock}`
  );
  assert.match(
    noiseBlock,
    /mem-y/,
    `mem-y (changed:0) MUST be in Noise.\n--- NOISE BLOCK ---\n${noiseBlock}`
  );
});

test('Behavior-changers includes memories with changed > 0 even when fired:0 (review-feedback)', () => {
  const { home, cwd, storeDir, telDir } = makeTempEnv();
  writeMemory(storeDir, 'mem-selfreport');
  writeEvents(telDir, 'sess1', [
    // Only behavior_changed rows — no `fired` events in this window.
    ...Array(2).fill({ event: 'behavior_changed', memory: 'mem-selfreport' }),
  ]);

  const { stdout, status } = runStats(home, cwd);
  assert.equal(status, 0);

  // The Behavior-changers section must list the memory; the Never-fired
  // section must not (changed > 0 disqualifies it from never-fired).
  const changersIdx = stdout.indexOf('Behavior-changers');
  assert.ok(changersIdx >= 0);
  const changersBlock = stdout.slice(changersIdx);
  assert.match(
    changersBlock,
    /mem-selfreport/,
    `mem-selfreport (fired:0 changed:2) MUST appear in Behavior-changers.\n${stdout}`
  );

  const neverIdx = stdout.indexOf('Never-fired');
  const neverBlock = stdout.slice(neverIdx, changersIdx);
  assert.doesNotMatch(
    neverBlock,
    /mem-selfreport/,
    `mem-selfreport must NOT appear in Never-fired.\n${neverBlock}`
  );
});

test('--changers-only suppresses Top influencers, Noise candidates, and Never-fired sections (R9)', () => {
  const { home, cwd, storeDir, telDir } = makeTempEnv();
  writeMemory(storeDir, 'mem-a');
  writeMemory(storeDir, 'mem-noise');
  writeMemory(storeDir, 'mem-never');
  writeEvents(telDir, 'sess1', [
    // mem-a: produces a Behavior-changers row AND a Top-influencers row.
    ...Array(5).fill({ event: 'fired', memory: 'mem-a' }),
    ...Array(3).fill({ event: 'cited', memory: 'mem-a' }),
    ...Array(2).fill({ event: 'behavior_changed', memory: 'mem-a' }),
    // mem-noise: noise candidate.
    ...Array(15).fill({ event: 'fired', memory: 'mem-noise' }),
    // mem-never: never-fired (no events).
  ]);

  const { stdout, status } = runStats(home, cwd, ['--changers-only']);
  assert.equal(status, 0);
  assert.match(stdout, /Behavior-changers/, 'Behavior-changers section must still render');
  assert.doesNotMatch(stdout, /Top influencers/, `Top influencers must be suppressed.\n${stdout}`);
  assert.doesNotMatch(
    stdout,
    /Noise candidates/,
    `Noise candidates must be suppressed.\n${stdout}`
  );
  assert.doesNotMatch(stdout, /Never-fired/, `Never-fired must be suppressed.\n${stdout}`);
});
