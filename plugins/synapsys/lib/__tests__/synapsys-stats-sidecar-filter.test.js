'use strict';

// Blocker 3 regression — synapsys-stats.listJsonlFiles must skip
// underscore-prefixed sidecar files in the telemetry dir so files like
// `_session-rotations.jsonl` (from session-id-rotation.js) don't get
// mis-parsed as per-memory event rows.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATS = path.resolve(__dirname, '..', '..', 'scripts', 'synapsys-stats.js');

test('listJsonlFiles excludes leading-underscore sidecars', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-stats-sidecar-'));
  try {
    fs.writeFileSync(path.join(dir, 'real-session.jsonl'), '');
    fs.writeFileSync(path.join(dir, '_session-rotations.jsonl'), '');
    fs.writeFileSync(path.join(dir, '_test-sidecar.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'not-jsonl.txt'), '');
    delete require.cache[require.resolve(STATS)];
    const { listJsonlFiles } = require(STATS);
    const files = listJsonlFiles(dir)
      .map((p) => path.basename(p))
      .sort();
    assert.deepEqual(files, ['real-session.jsonl']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listJsonlFiles tolerates missing telemetry dir', () => {
  delete require.cache[require.resolve(STATS)];
  const { listJsonlFiles } = require(STATS);
  const result = listJsonlFiles(path.join(os.tmpdir(), 'definitely-does-not-exist-' + Date.now()));
  assert.deepEqual(result, []);
});
