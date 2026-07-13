'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const memoryStore = require('../memory-store');

function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const ret = fn();
    return { ret, stderr: chunks.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

// Point memory-store at a tmpdir presets file via SYNAPSYS_PRESETS_PATH so
// the shipped synapsys-presets.json is never mutated. Mutating the real file
// would race with any concurrent worker calling loadPresets() — that worker
// would cache an empty Map for its lifetime.
function withPresetsFile(replacement, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapsys-presets-test-'));
  const tmpPath = path.join(dir, 'synapsys-presets.json');
  fs.writeFileSync(tmpPath, replacement);
  const previousEnv = process.env.SYNAPSYS_PRESETS_PATH;
  process.env.SYNAPSYS_PRESETS_PATH = tmpPath;
  try {
    delete require.cache[require.resolve('../memory-store')];
    const fresh = require('../memory-store');
    return fn(fresh);
  } finally {
    if (previousEnv === undefined) {
      delete process.env.SYNAPSYS_PRESETS_PATH;
    } else {
      process.env.SYNAPSYS_PRESETS_PATH = previousEnv;
    }
    delete require.cache[require.resolve('../memory-store')];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- 1.1.1 RED assertions ---

test('loadPresets() returns a Map containing git-ops, ci-monitor, review-comment-handling', () => {
  const { loadPresets } = memoryStore;
  assert.equal(typeof loadPresets, 'function', 'loadPresets must be exported');
  const presets = loadPresets();
  assert.ok(presets instanceof Map, 'loadPresets must return a Map');
  assert.ok(presets.has('git-ops'), 'preset "git-ops" must be present');
  assert.ok(presets.has('ci-monitor'), 'preset "ci-monitor" must be present');
  assert.ok(
    presets.has('review-comment-handling'),
    'preset "review-comment-handling" must be present'
  );
});

test('resolvePreset("git-ops") returns a non-empty regex string', () => {
  const { resolvePreset } = memoryStore;
  assert.equal(typeof resolvePreset, 'function', 'resolvePreset must be exported');
  const body = resolvePreset('git-ops');
  assert.equal(typeof body, 'string');
  assert.ok(body.length > 0, 'git-ops preset must resolve to a non-empty string');
});

test('resolvePreset("does-not-exist") returns null and emits stderr warning', () => {
  const { resolvePreset } = memoryStore;
  const { ret, stderr } = captureStderr(() => resolvePreset('does-not-exist'));
  assert.equal(ret, null);
  assert.match(stderr, /does-not-exist/);
});

test('malformed synapsys-presets.json: loadPresets returns empty Map + stderr warning', () => {
  withPresetsFile('{not valid json', (fresh) => {
    const { ret, stderr } = captureStderr(() => fresh.loadPresets());
    assert.ok(ret instanceof Map, 'loadPresets must still return a Map on bad JSON');
    assert.equal(ret.size, 0, 'malformed JSON must degrade to empty Map');
    assert.match(stderr, /presets\.json invalid/);
  });
});
