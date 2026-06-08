'use strict';

// Blocker 3 regression — synapsys-stats.listJsonlFiles must skip
// DOUBLE-underscore sidecar files in the telemetry dir so files like
// `__session-rotations.jsonl` (from session-id-rotation.js) don't get
// mis-parsed as per-memory event rows. Single-underscore names like
// `_unknown-session.jsonl` and SAFE_ID_RE-allowed `_`-prefixed session
// ids ARE real telemetry data and must remain in scope.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const STATS = path.resolve(__dirname, '..', '..', 'scripts', 'synapsys-stats.js');

test('listJsonlFiles excludes double-underscore sidecars but KEEPS single-underscore telemetry buckets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-stats-sidecar-'));
  try {
    fs.writeFileSync(path.join(dir, 'real-session.jsonl'), '');
    // Single-underscore — legitimate telemetry data (must NOT be filtered):
    fs.writeFileSync(path.join(dir, '_unknown-session.jsonl'), '');
    fs.writeFileSync(path.join(dir, '_user_id_with_underscore.jsonl'), '');
    // Double-underscore — sidecars (filtered out):
    fs.writeFileSync(path.join(dir, '__session-rotations.jsonl'), '');
    fs.writeFileSync(path.join(dir, '__test-sidecar.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'not-jsonl.txt'), '');
    delete require.cache[require.resolve(STATS)];
    const { listJsonlFiles } = require(STATS);
    const files = listJsonlFiles(dir)
      .map((p) => path.basename(p))
      .sort();
    assert.deepEqual(files, [
      '_unknown-session.jsonl',
      '_user_id_with_underscore.jsonl',
      'real-session.jsonl',
    ]);
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
