'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detect, markConfigured, loadCache } = require('../detect');
const { schemaHash } = require('../schema');

const schema = {
  plugin: 'demo',
  prefixes: ['DEMO_'],
  vars: {
    DEMO_REQUIRED: { type: 'string', default: '', description: 'r', section: 'S', required: true },
    DEMO_OPTIONAL: { type: 'string', default: '', description: 'o', section: 'S' },
    DEMO_ADVANCED: { type: 'string', default: '', description: 'a', section: 'S', advanced: true },
  },
};

let tmp;
let cachePath;
const projectRoot = '/fake/project';

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'envcfg-detect-'));
  cachePath = path.join(tmp, 'cache', 'envconfig.json');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('first run reports non-advanced unset vars as missing', () => {
  const result = detect({ schema, cachePath, projectRoot, values: {} });
  assert.equal(result.changed, true);
  assert.equal(result.firstRun, true);
  assert.deepEqual(result.missing, ['DEMO_REQUIRED', 'DEMO_OPTIONAL']);
});

test('set values and acknowledged vars are not missing', () => {
  markConfigured({
    cachePath,
    projectRoot,
    plugin: 'demo',
    hash: 'stale-hash',
    acknowledgedVars: ['DEMO_OPTIONAL'],
  });
  const values = { DEMO_REQUIRED: { value: 'x', dynamic: false, source: 'envrc' } };
  const result = detect({ schema, cachePath, projectRoot, values });
  assert.equal(result.changed, true);
  assert.equal(result.firstRun, false);
  assert.deepEqual(result.missing, []);
});

test('markConfigured enables the fast path until the schema changes', () => {
  const first = detect({ schema, cachePath, projectRoot, values: {} });
  markConfigured({ cachePath, projectRoot, plugin: 'demo', hash: first.hash });
  assert.deepEqual(detect({ schema, cachePath, projectRoot, values: {} }), {
    changed: false,
    hash: first.hash,
    acknowledgedVars: [],
  });

  const grown = JSON.parse(JSON.stringify(schema));
  grown.vars.DEMO_NEW = { type: 'string', default: '', description: 'n', section: 'S' };
  const redetect = detect({ schema: grown, cachePath, projectRoot, values: {} });
  assert.equal(redetect.changed, true);
  assert.ok(redetect.missing.includes('DEMO_NEW'));
});

test('acknowledged vars accumulate across configure passes', () => {
  markConfigured({
    cachePath,
    projectRoot,
    plugin: 'demo',
    hash: 'h1',
    acknowledgedVars: ['DEMO_REQUIRED'],
  });
  markConfigured({
    cachePath,
    projectRoot,
    plugin: 'demo',
    hash: 'h2',
    acknowledgedVars: ['DEMO_OPTIONAL'],
  });
  const entry = loadCache(cachePath).projects[projectRoot].demo;
  assert.deepEqual(entry.acknowledgedVars.sort(), ['DEMO_OPTIONAL', 'DEMO_REQUIRED']);
  assert.equal(entry.schemaHash, 'h2');
});

test('corrupt cache is treated as first run, then recovers', () => {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, '{ not json');
  const result = detect({ schema, cachePath, projectRoot, values: {} });
  assert.equal(result.firstRun, true);
  markConfigured({ cachePath, projectRoot, plugin: 'demo', hash: schemaHash(schema) });
  assert.equal(detect({ schema, cachePath, projectRoot, values: {} }).changed, false);
});
