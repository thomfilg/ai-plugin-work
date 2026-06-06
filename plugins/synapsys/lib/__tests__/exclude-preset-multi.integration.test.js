'use strict';

/**
 * GH-510 retrofit fallback — proves multi-preset `exclude_preset` composition.
 *
 * The brief's preferred retrofit candidate
 * (`linear-no-external-refs-cortex-instead`) is not shipped under
 * `plugins/synapsys/` version control, so this test instead exercises a
 * new fixture that adopts BOTH `git-ops` and `ci-monitor` presets at once.
 *
 * Contract:
 *   - `excludePreset` round-trips to the parsed CSV
 *   - `excludeResolved` carries one entry per resolved preset (length === 2)
 *   - prompts matching EITHER preset are suppressed with reason
 *     `exclude-matched`
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { listMemoriesFromStore } = require('../memory-store');
const { matchPrompt } = require('../matcher');

const FIXTURE_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'tests',
  'fixtures',
  'store-exclude-multi-preset'
);

function loadFixture() {
  const store = { kind: 'local', dir: FIXTURE_DIR, projectName: 'multi-preset' };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1, 'expected exactly one fixture memory');
  return memories[0];
}

test('multi-preset fixture parses exclude_preset CSV into both names', () => {
  const m = loadFixture();
  assert.deepEqual(m.excludePreset, ['git-ops', 'ci-monitor']);
});

test('multi-preset fixture resolves both presets into excludeResolved (length === 2)', () => {
  const m = loadFixture();
  assert.ok(Array.isArray(m.excludeResolved));
  assert.equal(
    m.excludeResolved.length,
    2,
    'excludeResolved must carry one body per resolved preset'
  );
});

test('git-ops prompt is suppressed (exclude-matched)', () => {
  const m = loadFixture();
  const r = matchPrompt(m, 'git rebase the ticket branch');
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'exclude-matched');
});

test('ci-monitor prompt is suppressed (exclude-matched)', () => {
  const m = loadFixture();
  const r = matchPrompt(m, 'gh run watch the linear ticket job');
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'exclude-matched');
});

test('non-excluded ticket prompt still fires', () => {
  const m = loadFixture();
  const r = matchPrompt(m, 'open the ticket and read the description');
  assert.equal(r.fired, true);
});
