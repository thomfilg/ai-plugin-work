'use strict';

/**
 * GH-510 Task 5 — Worked example: a fixture memory adopts
 * `exclude_preset: git-ops` so the end-to-end load → match → suppression
 * flow is exercised against the shipped preset bundle.
 *
 * The fixture lives under `plugins/synapsys/tests/fixtures/` so the docs
 * in Task 6 can link to it as the canonical worked example for R7.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { listMemoriesFromStore } = require('../memory-store');
const { matchPrompt } = require('../matcher');

const FIXTURE_DIR = path.resolve(
  __dirname,
  '..',
  '..',
  'tests',
  'fixtures',
  'store-exclude-worked-example'
);
const FIXTURE_FILE = path.join(FIXTURE_DIR, 'mem-worked-example.md');

test('worked-example fixture file exists under tests/fixtures/', () => {
  assert.ok(
    fs.existsSync(FIXTURE_FILE),
    `worked-example fixture missing at ${FIXTURE_FILE}`
  );
});

test('loading the worked-example store yields excludePreset=[git-ops] with non-empty excludeResolved', () => {
  const store = {
    kind: 'local',
    dir: FIXTURE_DIR,
    projectName: 'worked-example',
  };
  const memories = listMemoriesFromStore(store);
  assert.equal(memories.length, 1, 'expected exactly one fixture memory');
  const m = memories[0];
  assert.deepEqual(m.excludePreset, ['git-ops']);
  assert.ok(
    Array.isArray(m.excludeResolved) && m.excludeResolved.length > 0,
    'excludeResolved must be populated from the git-ops preset'
  );
});

test('a `git rebase` prompt that hits trigger_prompt is suppressed with reason exclude-matched', () => {
  const store = {
    kind: 'local',
    dir: FIXTURE_DIR,
    projectName: 'worked-example',
  };
  const memories = listMemoriesFromStore(store);
  const m = memories[0];
  const result = matchPrompt(m, 'git rebase the ticket branch');
  assert.equal(result.fired, false);
  assert.equal(result.reason, 'exclude-matched');
  assert.ok(
    result.matched && typeof result.matched.excluded_pattern === 'string',
    'matched.excluded_pattern must be present'
  );
});

test('a non-git prompt that hits trigger_prompt fires normally', () => {
  const store = {
    kind: 'local',
    dir: FIXTURE_DIR,
    projectName: 'worked-example',
  };
  const memories = listMemoriesFromStore(store);
  const m = memories[0];
  const result = matchPrompt(m, 'open the ticket and read the description');
  assert.equal(result.fired, true, 'non-git prompt must fire (no exclude match)');
});
