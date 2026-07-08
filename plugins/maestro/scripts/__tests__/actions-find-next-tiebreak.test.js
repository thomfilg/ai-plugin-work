// findNextEligibleTask: when two manifests have eligible tasks with the same
// priority, the pick must be deterministic across filesystems. We stabilize
// readdirSync order by sorting filenames, which gives a ticket-id tie-break
// (since manifests are named after the topic/ticket).

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const ACTIONS_PATH = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'actions');

function freshActions({ stateDir, alertFile, sessionDir, tmuxStub, env = {} }) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct')) delete require.cache[k];
  }
  process.env.STATE_DIR = stateDir;
  process.env.ALERT_FILE = alertFile;
  process.env.LOG_FILE = path.join(stateDir, '.log');
  process.env.MAESTRO_SESSION_DIR = sessionDir;
  delete process.env.AUTO_FREE_CI_SLOT;
  delete process.env.AUTO_BOOTSTRAP_NEXT;
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  const cp = require('child_process');
  cp.spawnSync = (cmd, args) => {
    if (cmd === 'tmux') {
      tmuxStub.push({ cmd, args });
      return { status: 0, stdout: '' };
    }
    return { status: 0, stdout: '' };
  };
  return require(ACTIONS_PATH);
}

function writeManifest(dir, name, topic, tasks) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify({ topic, tasks }));
}

test('findNextEligibleTask: equal-priority tasks broken by filename order (deterministic)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fne-tb-'));
  const stateDir = path.join(root, 'state');
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  const tmuxStub = [];

  // Two manifests, two eligible tasks, SAME priority. Write the
  // "higher" filename first so naive readdirSync order could pick either
  // depending on FS; sorted order must always pick GH-100 (filename
  // GH-100.json sorts before GH-200.json).
  writeManifest(sessionDir, 'GH-200.json', 'GH-200', [
    { id: 'task1', status: 'pending', priority: 5 },
  ]);
  writeManifest(sessionDir, 'GH-100.json', 'GH-100', [
    { id: 'taskA', status: 'pending', priority: 5 },
  ]);

  const actions = freshActions({ stateDir, alertFile, sessionDir, tmuxStub });
  // Drive findNextEligibleTask via freeCIGateSlot, which surfaces the result
  // in the slot-freed alert's nextTopic field.
  actions.freeCIGateSlot({ session: 'X-listen', ticket: 'X', prNumber: 1, sha: 'a' });

  const alerts = fs
    .readFileSync(alertFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  const slotFreed = alerts.find((a) => a.kind === 'slot-freed');
  assert.ok(slotFreed, 'expected a slot-freed alert');
  assert.equal(slotFreed.nextTopic, 'GH-100', 'tie-break must be deterministic by filename');
});

test('findNextEligibleTask: lower priority still wins regardless of filename order', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fne-pri-'));
  const stateDir = path.join(root, 'state');
  const sessionDir = path.join(root, 'sessions');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const alertFile = path.join(stateDir, 'alerts.jsonl');
  const tmuxStub = [];

  // GH-100.json sorts first, but its task has WORSE (higher) priority.
  // The lower-priority task in GH-200.json must still win — sort must not
  // override the priority comparison.
  writeManifest(sessionDir, 'GH-100.json', 'GH-100', [
    { id: 'taskA', status: 'pending', priority: 9 },
  ]);
  writeManifest(sessionDir, 'GH-200.json', 'GH-200', [
    { id: 'task1', status: 'pending', priority: 1 },
  ]);

  const actions = freshActions({ stateDir, alertFile, sessionDir, tmuxStub });
  actions.freeCIGateSlot({ session: 'Y-listen', ticket: 'Y', prNumber: 2, sha: 'b' });

  const alerts = fs
    .readFileSync(alertFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(JSON.parse);
  const slotFreed = alerts.find((a) => a.kind === 'slot-freed');
  assert.ok(slotFreed);
  assert.equal(slotFreed.nextTopic, 'GH-200', 'priority must outrank filename tie-break');
});
