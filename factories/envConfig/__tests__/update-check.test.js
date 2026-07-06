'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  compareSemver,
  check,
  refresh,
  writeState,
  isFresh,
  DEFAULT_TTL_MS,
} = require('../updateCheck');

let tmp;
let cachePath;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'envcfg-update-'));
  cachePath = path.join(tmp, 'update.json');
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('compareSemver orders numerically, tolerates v-prefix', () => {
  assert.ok(compareSemver('3.10.0', '3.9.9') > 0);
  assert.ok(compareSemver('v3.0.0', '3.0.1') < 0);
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
});

test('check: banner only when cached latest is newer', () => {
  const now = Date.now();
  writeState(cachePath, { checkedAt: new Date(now).toISOString(), latest: '9.9.9', source: 'npm' });
  const newer = check({
    cachePath,
    packageName: 'pkg',
    current: '1.0.0',
    updateHint: 'git pull',
    now,
  });
  assert.match(newer.banner, /pkg v9\.9\.9 available \(current: v1\.0\.0\)/);
  assert.match(newer.banner, /git pull/);
  assert.equal(newer.needsRefresh, false);

  writeState(cachePath, { checkedAt: new Date(now).toISOString(), latest: '1.0.0', source: 'npm' });
  assert.equal(check({ cachePath, packageName: 'pkg', current: '1.0.0', now }).banner, null);
});

test('check: stale or absent cache requests a refresh, never blocks', () => {
  const now = Date.now();
  assert.equal(check({ cachePath, packageName: 'pkg', current: '1.0.0', now }).needsRefresh, true);
  writeState(cachePath, {
    checkedAt: new Date(now - DEFAULT_TTL_MS - 1000).toISOString(),
    latest: null,
    source: null,
  });
  const result = check({ cachePath, packageName: 'pkg', current: '1.0.0', now });
  assert.equal(result.needsRefresh, true);
  assert.equal(result.banner, null);
});

test('isFresh honors the TTL boundary', () => {
  const now = Date.now();
  const state = { checkedAt: new Date(now - 1000).toISOString() };
  assert.equal(isFresh(state, DEFAULT_TTL_MS, now), true);
  assert.equal(isFresh(state, 500, now), false);
  assert.equal(isFresh(null, DEFAULT_TTL_MS, now), false);
});

test('update-check hook prints a banner from a fresh cache, never blocks', () => {
  const { spawnSync } = require('node:child_process');
  const repoRoot = path.join(__dirname, '..', '..', '..');
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const home = path.join(tmp, 'home');
  const hookCache = path.join(home, '.claude', '.cache', `update-${pkg.name}.json`);
  fs.mkdirSync(path.dirname(hookCache), { recursive: true });
  // Fresh cache with a newer version: banner expected, no refresh spawned.
  writeState(hookCache, {
    checkedAt: new Date().toISOString(),
    latest: '999.0.0',
    source: 'npm',
  });
  const result = spawnSync(
    process.execPath,
    [path.join(repoRoot, 'plugins', 'work', 'hooks', 'update-check.js')],
    { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home }, timeout: 10000 }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /v999\.0\.0 available/);
});

test('refresh: npm hit wins, git raw is the fallback, offline is silent', async () => {
  const okJson = (body) => ({ ok: true, json: async () => body });
  const notFound = { ok: false, json: async () => ({}) };

  let result = await refresh({
    cachePath,
    packageName: 'pkg',
    fallbackRawUrl: 'https://raw.example/package.json',
    fetchImpl: async (url) =>
      url.includes('registry.npmjs.org') ? okJson({ version: '2.0.0' }) : notFound,
  });
  assert.deepEqual(result, { latest: '2.0.0', source: 'npm' });

  result = await refresh({
    cachePath,
    packageName: 'pkg',
    fallbackRawUrl: 'https://raw.example/package.json',
    fetchImpl: async (url) =>
      url.includes('registry.npmjs.org') ? notFound : okJson({ version: '3.0.0' }),
  });
  assert.deepEqual(result, { latest: '3.0.0', source: 'git' });

  result = await refresh({
    cachePath,
    packageName: 'pkg',
    fallbackRawUrl: 'https://raw.example/package.json',
    fetchImpl: async () => {
      throw new Error('offline');
    },
  });
  assert.deepEqual(result, { latest: null, source: null });
  const state = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(state.latest, null);
  assert.ok(state.checkedAt);
});
