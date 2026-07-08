'use strict';

// GH-520: the status script's Enforce section — memories with enforce ≠ advise
// plus per-session block/override telemetry counts. Spawned end-to-end with an
// isolated HOME.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATUS = path.resolve(__dirname, '..', 'synapsys-status.js');

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-status-enf-'));
  const home = path.join(base, 'home');
  const cwd = path.join(base, 'project');
  const storeDir = path.join(cwd, '.claude', 'synapsys');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(
    path.join(storeDir, '.synapsys.json'),
    JSON.stringify({ kind: 'local', projectName: 'status-enf', schemaVersion: 1 })
  );
  return { home, cwd, storeDir };
}

function writeMemory(storeDir, name, extraFm = '') {
  fs.writeFileSync(
    path.join(storeDir, `${name}.md`),
    `---\nname: ${name}\nevents: PreToolUse\ntrigger_pretool: Bash:x\n${extraFm}---\nbody\n`
  );
}

function runStatus(fix, args) {
  return spawnSync(process.execPath, [STATUS, ...args], {
    cwd: fix.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fix.home,
      SYNAPSYS_HOME: fix.home,
      SYNAPSYS_DISABLE_HOME_STORES: '1',
      CLAUDE_CODE_SESSION_ID: '',
    },
  });
}

test('status --json reports enforce memories and block/override counts for the session', () => {
  const fix = setup();
  writeMemory(fix.storeDir, 'plain-mem');
  writeMemory(fix.storeDir, 'blocky', 'enforce: block\nenforce_classifier: symbol-shape\n');
  writeMemory(fix.storeDir, 'nudgey', 'enforce: suggest\n');

  const sid = 'status-enf-1';
  const telDir = path.join(fix.home, '.claude', 'synapsys', '.telemetry');
  fs.mkdirSync(telDir, { recursive: true });
  fs.writeFileSync(
    path.join(telDir, `${sid}.jsonl`),
    [
      JSON.stringify({ memory: 'blocky', event: 'block', tool: 'Bash' }),
      JSON.stringify({ memory: 'blocky', event: 'block', tool: 'Grep' }),
      JSON.stringify({ memory: 'blocky', event: 'override', reason: 'a long enough reason' }),
      JSON.stringify({ memory: 'plain-mem', event: 'fired' }),
      '',
    ].join('\n')
  );

  const r = runStatus(fix, ['--json', `--session-id=${sid}`]);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  assert.equal(typeof parsed.enforce, 'object');
  assert.equal(parsed.enforce.sessionId, sid);
  assert.deepEqual(parsed.enforce.counts, { block: 2, override: 1 });
  const names = parsed.enforce.memories.map((m) => m.name).sort();
  assert.deepEqual(names, ['blocky', 'nudgey']);
  const blocky = parsed.enforce.memories.find((m) => m.name === 'blocky');
  assert.equal(blocky.enforce, 'block');
  assert.equal(blocky.classifier, 'symbol-shape');
});

test('status human output renders the Enforce section and fails open with no data', () => {
  const fix = setup();
  const r = runStatus(fix, ['--no-color', '--session-id=fresh-session']);
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /Enforce/);
  assert.match(r.stdout, /no memories with enforce/);
  assert.match(r.stdout, /block=0 override=0/);
});
