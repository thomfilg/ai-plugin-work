'use strict';

/**
 * synapsys-memorize CLI — Stop/PostToolUse authoring + fire_mode/fire_cadence/
 * domain flags. The script previously rejected the Stop and PostToolUse events
 * (which the dispatcher supports) and had no way to set fire_mode — this pins
 * the extended flag surface and its validation (mirroring memory-store's
 * normalization rules, but rejecting instead of silently falling back).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MEMORIZE = path.resolve(__dirname, '..', 'synapsys-memorize.js');

function makeTempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-memorize-'));
  const storeDir = path.join(dir, '.claude', 'synapsys');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, '.synapsys.json'), JSON.stringify({ projectName: 'test' }));
  return { cwd: dir, storeDir };
}

function runMemorize(cwd, flags, body = 'memory body\n') {
  return spawnSync(process.execPath, [MEMORIZE, `--cwd=${cwd}`, ...flags], {
    input: body,
    encoding: 'utf8',
    env: { ...process.env, SYNAPSYS_DISABLE_HOME_STORES: '1' },
  });
}

test('memorize accepts Stop with --stop-response and writes trigger_stop_response', () => {
  const { cwd, storeDir } = makeTempStore();
  const res = runMemorize(cwd, [
    '--name=stop-mem',
    '--desc=d',
    '--events=Stop',
    '--stop-response=\\bflaky\\b',
  ]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const raw = fs.readFileSync(path.join(storeDir, 'stop-mem.md'), 'utf8');
  assert.match(raw, /events: Stop/);
  assert.match(raw, /trigger_stop_response: \\bflaky\\b/);
});

test('memorize rejects Stop without --stop-response (dead memory guard)', () => {
  const { cwd } = makeTempStore();
  const res = runMemorize(cwd, ['--name=stop-dead', '--desc=d', '--events=Stop']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--stop-response is required/);
});

test('memorize accepts PostToolUse when --pretool is provided', () => {
  const { cwd, storeDir } = makeTempStore();
  const res = runMemorize(cwd, [
    '--name=post-mem',
    '--desc=d',
    '--events=PostToolUse',
    '--pretool=Bash:git\\s+push',
  ]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const raw = fs.readFileSync(path.join(storeDir, 'post-mem.md'), 'utf8');
  assert.match(raw, /events: PostToolUse/);
});

test('memorize rejects PostToolUse without --pretool', () => {
  const { cwd } = makeTempStore();
  const res = runMemorize(cwd, ['--name=post-dead', '--desc=d', '--events=PostToolUse']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--pretool is required when events includes PostToolUse/);
});

test('memorize writes fire_mode / fire_cadence / domain and memory-store parses them back', () => {
  const { cwd, storeDir } = makeTempStore();
  const res = runMemorize(cwd, [
    '--name=cadence-mem',
    '--desc=d',
    '--events=UserPromptSubmit',
    '--prompt=\\bdeploy\\b',
    '--fire-mode=occasionally',
    '--fire-cadence=3',
    '--domain=git,ci',
  ]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);

  const { listMemoriesFromStore } = require('../../lib/memory-store');
  const memories = listMemoriesFromStore({ kind: 'local', dir: storeDir, projectName: 'test' });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].fireMode, 'occasionally');
  assert.equal(memories[0].fireCadence, 3);
  assert.deepEqual(memories[0].domain, ['git', 'ci']);
});

test('memorize rejects an invalid --fire-mode instead of silently falling back', () => {
  const { cwd } = makeTempStore();
  const res = runMemorize(cwd, [
    '--name=bad-mode',
    '--desc=d',
    '--events=UserPromptSubmit',
    '--prompt=x',
    '--fire-mode=sometimes',
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--fire-mode must be one of always, once, occasionally/);
});

test('memorize rejects a non-positive-integer --fire-cadence', () => {
  const { cwd } = makeTempStore();
  for (const bad of ['0', '-2', '1.5', 'often']) {
    const res = runMemorize(cwd, [
      '--name=bad-cadence',
      '--desc=d',
      '--events=UserPromptSubmit',
      '--prompt=x',
      `--fire-cadence=${bad}`,
    ]);
    assert.notEqual(res.status, 0, `--fire-cadence=${bad} should be rejected`);
    assert.match(res.stderr, /--fire-cadence must be a positive integer/);
  }
});

test('memorize still rejects a truly unknown event', () => {
  const { cwd } = makeTempStore();
  const res = runMemorize(cwd, ['--name=x-mem', '--desc=d', '--events=SubagentStop']);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unknown event 'SubagentStop'/);
});

// ── GH-520 enforce flags ──────────────────────────────────────────────────────

test('memorize writes enforce / enforce_classifier / enforce_satisfied_by frontmatter', () => {
  const { cwd, storeDir } = makeTempStore();
  const res = runMemorize(cwd, [
    '--name=recall-gate',
    '--desc=d',
    '--events=PreToolUse',
    '--pretool=Edit:',
    '--enforce=block',
    '--enforce-classifier=first-edit-of-session',
    '--enforce-satisfied-by=cortex_recall',
  ]);
  assert.equal(res.status, 0, `stderr: ${res.stderr}`);
  const raw = fs.readFileSync(path.join(storeDir, 'recall-gate.md'), 'utf8');
  assert.match(raw, /enforce: block/);
  assert.match(raw, /enforce_classifier: first-edit-of-session/);
  assert.match(raw, /enforce_satisfied_by: cortex_recall/);
});

test('memorize rejects an invalid --enforce value', () => {
  const { cwd } = makeTempStore();
  const res = runMemorize(cwd, [
    '--name=bad-enforce',
    '--desc=d',
    '--events=PreToolUse',
    '--pretool=Bash:x',
    '--enforce=blocc',
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--enforce must be one of advise, suggest, block/);
});

test('memorize rejects --enforce=block and --enforce=suggest without --pretool', () => {
  const { cwd } = makeTempStore();
  for (const level of ['block', 'suggest']) {
    const res = runMemorize(cwd, [
      `--name=dead-${level}`,
      '--desc=d',
      '--events=UserPromptSubmit',
      '--prompt=x',
      `--enforce=${level}`,
    ]);
    assert.notEqual(res.status, 0, `--enforce=${level} without --pretool should be rejected`);
    assert.match(res.stderr, /requires --pretool/);
  }
});

test('memorize rejects an unknown --enforce-classifier name', () => {
  const { cwd } = makeTempStore();
  const res = runMemorize(cwd, [
    '--name=bad-classifier',
    '--desc=d',
    '--events=PreToolUse',
    '--pretool=Grep:',
    '--enforce=block',
    '--enforce-classifier=vibes',
  ]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /--enforce-classifier must be one of/);
});
