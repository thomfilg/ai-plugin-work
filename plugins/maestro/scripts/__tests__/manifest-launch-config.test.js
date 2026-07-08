// manifest.js — launch-config lookup + stale-manifest shadowing regressions.
//
// A ticket that appears in a stale 12-day-old manifest AND a live one used to
// resolve by filesystem readdir order — silently returning the stale (null)
// stopOracle and disabling the whole stop-condition pipeline. findTask now
// prefers the newest createdAt.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');

const MOD = path.resolve(__dirname, '..', 'lib', 'maestro-conduct', 'manifest.js');

function freshManifest(sessionDir) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/maestro-conduct/')) delete require.cache[k];
  }
  process.env.MAESTRO_SESSION_DIR = sessionDir;
  return require(MOD);
}

function writeManifestFile(dir, name, obj) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));
}

test('findTask prefers the manifest with the newest createdAt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-shadow-'));
  // "aaa-stale" sorts FIRST by readdir order — the old bug returned it.
  writeManifestFile(dir, 'aaa-stale.json', {
    topic: 'aaa-stale',
    slots: 2,
    command: 'work',
    stopOracle: null,
    createdAt: '2026-06-01T00:00:00.000Z',
    tasks: [{ id: 'GH-42', priority: 1, deps: [], status: 'pending' }],
  });
  writeManifestFile(dir, 'zzz-live.json', {
    topic: 'zzz-live',
    slots: 2,
    command: 'qc-work',
    commandBrief: 'authors QC task packages; done = oracle exit 0',
    stopOracle: 'exit 0',
    createdAt: '2026-07-01T00:00:00.000Z',
    tasks: [{ id: 'GH-42', priority: 1, deps: [], status: 'in_progress' }],
  });
  const manifest = freshManifest(dir);

  const hit = manifest.findTask('GH-42');
  assert.equal(hit.manifest.topic, 'zzz-live', 'newest manifest must win');
  assert.equal(manifest.stopOracleForTask('GH-42'), 'exit 0');
  assert.equal(manifest.commandForTask('GH-42'), 'qc-work');
});

test('launchConfigForTask returns command + commandBrief; empty for unknown tickets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-launch-'));
  writeManifestFile(dir, 'topic.json', {
    topic: 'topic',
    slots: 1,
    command: '/qc-work',
    commandBrief: 'the brief',
    createdAt: new Date().toISOString(),
    tasks: [{ id: 'GH-7', priority: 1, deps: [], status: 'pending' }],
  });
  const manifest = freshManifest(dir);
  assert.deepEqual(manifest.launchConfigForTask('GH-7'), {
    command: 'qc-work',
    commandBrief: 'the brief',
  });
  assert.deepEqual(manifest.launchConfigForTask('GH-404'), {
    command: null,
    commandBrief: null,
  });
});

test('poolFullForTask ignores live sessions of done tickets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-pool-'));
  writeManifestFile(dir, 'topic.json', {
    topic: 'topic',
    slots: 1,
    createdAt: new Date().toISOString(),
    tasks: [
      { id: 'GH-10', priority: 1, deps: [], status: 'done' },
      { id: 'GH-11', priority: 2, deps: [], status: 'pending' },
    ],
  });
  const manifest = freshManifest(dir);
  // GH-10's session is parked alive after its oracle passed — it must not
  // count against the pool for GH-11.
  assert.equal(manifest.poolFullForTask('GH-11', ['GH-10-work']), false);
  // A genuinely active non-done ticket still fills the slot.
  writeManifestFile(dir, 'topic.json', {
    topic: 'topic',
    slots: 1,
    createdAt: new Date().toISOString(),
    tasks: [
      { id: 'GH-10', priority: 1, deps: [], status: 'in_progress' },
      { id: 'GH-11', priority: 2, deps: [], status: 'pending' },
    ],
  });
  const manifest2 = freshManifest(dir);
  assert.equal(manifest2.poolFullForTask('GH-11', ['GH-10-work']), true);
});
