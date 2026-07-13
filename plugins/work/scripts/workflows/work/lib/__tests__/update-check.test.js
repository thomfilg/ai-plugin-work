/**
 * Tests for update-check.js — the non-blocking version-update banner module.
 *
 * Covers pure helpers (compareSemver, version-shape validator), installed-version
 * read, 24h-TTL cache I/O, the HTTPS fetch (driven through an injected transport
 * shim), and the `maybeUpdateBanner(opts)` orchestration (opt-out env, session
 * de-dup marker, cache-first/fetch-fallback, compare, banner formatting, and the
 * never-throw contract).
 *
 * node:test + node:assert/strict. No real network or home-dir I/O: every seam is
 * injected (`now`, `cacheDir`, `installedVersion`, `fetch`) and temp dirs use
 * fs.mkdtempSync + rmSync({recursive,force}).
 */

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Lazy-load the (not-yet-implemented) module so a missing source file surfaces
// as a per-test behavior failure rather than a load-time crash of the suite.
const MODULE_PATH = path.join(__dirname, '..', 'update-check');
function load() {
  return require(MODULE_PATH);
}
const compareSemver = (...a) => load().compareSemver(...a);
const isValidVersion = (...a) => load().isValidVersion(...a);
const readInstalledVersion = (...a) => load().readInstalledVersion(...a);
const readCache = (...a) => load().readCache(...a);
const writeCache = (...a) => load().writeCache(...a);
const fetchLatestVersion = (...a) => load().fetchLatestVersion(...a);
const maybeUpdateBanner = (...a) => load().maybeUpdateBanner(...a);

const DAY_MS = 24 * 60 * 60 * 1000;

function makeMarketplaceBody(version) {
  return JSON.stringify({ name: 'work-workflow', metadata: { version } });
}

// A fetch transport shim: resolves with { status, body } or rejects.
function okFetch(version) {
  return async () => ({ status: 200, body: makeMarketplaceBody(version) });
}

let tmp;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'update-check-test-'));
  delete process.env.WORK_DISABLE_UPDATE_CHECK;
  delete process.env.WORK_UPDATE_CHECK_CACHE_DIR;
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.WORK_DISABLE_UPDATE_CHECK;
  delete process.env.WORK_UPDATE_CHECK_CACHE_DIR;
});

// --- 1.1 compareSemver + validator (pure) ---------------------------------
describe('compareSemver', () => {
  it('returns 1 when major/minor/patch of a is greater', () => {
    assert.equal(compareSemver('3.50.0', '3.49.0'), 1);
    assert.equal(compareSemver('4.0.0', '3.49.0'), 1);
    assert.equal(compareSemver('3.49.1', '3.49.0'), 1);
  });

  it('returns 0 when equal', () => {
    assert.equal(compareSemver('3.49.0', '3.49.0'), 0);
  });

  it('returns -1 when a is lower', () => {
    assert.equal(compareSemver('3.49.0', '3.50.0'), -1);
    assert.equal(compareSemver('3.49.0', '3.49.1'), -1);
    assert.equal(compareSemver('2.99.99', '3.0.0'), -1);
  });
});

describe('isValidVersion', () => {
  it('returns true for a strict X.Y.Z string', () => {
    assert.equal(isValidVersion('3.49.0'), true);
    assert.equal(isValidVersion('0.0.0'), true);
    assert.equal(isValidVersion('10.20.30'), true);
  });

  it('returns false for non X.Y.Z strings', () => {
    assert.equal(isValidVersion('v3.49'), false);
    assert.equal(isValidVersion('3.49'), false);
    assert.equal(isValidVersion('foo'), false);
    assert.equal(isValidVersion('3.49.0-beta'), false);
    assert.equal(isValidVersion(''), false);
    assert.equal(isValidVersion(null), false);
    assert.equal(isValidVersion(undefined), false);
  });
});

// --- 1.2 readInstalledVersion ---------------------------------------------
describe('readInstalledVersion', () => {
  it('returns the version field from a plugin.json path', () => {
    const p = path.join(tmp, 'plugin.json');
    fs.writeFileSync(p, JSON.stringify({ name: 'work-workflow', version: '3.49.0' }));
    assert.equal(readInstalledVersion(p), '3.49.0');
  });

  it('returns null when the file is missing', () => {
    assert.equal(readInstalledVersion(path.join(tmp, 'does-not-exist.json')), null);
  });

  it('returns null when the file is not valid JSON', () => {
    const p = path.join(tmp, 'bad.json');
    fs.writeFileSync(p, '{ not json');
    assert.equal(readInstalledVersion(p), null);
  });

  it('returns the live plugin.json version when called with no argument', () => {
    // Falls back to the module's own plugin.json (currently 3.49.0).
    assert.equal(isValidVersion(readInstalledVersion()), true);
  });
});

// --- 1.3 readCache / writeCache (24h TTL I/O) ------------------------------
describe('readCache / writeCache', () => {
  it('round-trips a {latest, fetchedAt} entry', () => {
    const entry = { latest: '3.50.0', fetchedAt: 1000 };
    writeCache(tmp, entry);
    assert.deepEqual(readCache(tmp), entry);
  });

  it('returns null when no cache file exists', () => {
    assert.equal(readCache(tmp), null);
  });

  it('returns null for malformed JSON (parse error swallowed)', () => {
    writeCache(tmp, { latest: '3.50.0', fetchedAt: 1000 });
    // Corrupt the written file.
    const files = fs.readdirSync(tmp);
    fs.writeFileSync(path.join(tmp, files[0]), '{ broken');
    assert.equal(readCache(tmp), null);
  });

  it('does not throw when the dir is uncreatable / unusable', () => {
    // Point at a path whose parent is a file, so mkdir cannot create it.
    const fileAsParent = path.join(tmp, 'afile');
    fs.writeFileSync(fileAsParent, 'x');
    const badDir = path.join(fileAsParent, 'nested');
    assert.doesNotThrow(() => writeCache(badDir, { latest: '3.50.0', fetchedAt: 1 }));
    assert.equal(readCache(badDir), null);
  });
});

// --- 1.4 fetchLatestVersion (injected transport) --------------------------
describe('fetchLatestVersion', () => {
  it('returns the parsed metadata.version on a 200 with valid body', async () => {
    const v = await fetchLatestVersion(2500, { fetch: okFetch('3.50.0') });
    assert.equal(v, '3.50.0');
  });

  it('returns null on a non-200 status', async () => {
    const v = await fetchLatestVersion(2500, {
      fetch: async () => ({ status: 404, body: 'not found' }),
    });
    assert.equal(v, null);
  });

  it('returns null when the transport throws / times out', async () => {
    const v = await fetchLatestVersion(2500, {
      fetch: async () => {
        throw new Error('ETIMEDOUT');
      },
    });
    assert.equal(v, null);
  });

  it('returns null on malformed JSON body', async () => {
    const v = await fetchLatestVersion(2500, {
      fetch: async () => ({ status: 200, body: '{ not json' }),
    });
    assert.equal(v, null);
  });

  it('returns null when metadata.version fails the shape validator', async () => {
    const v = await fetchLatestVersion(2500, { fetch: okFetch('3.50') });
    assert.equal(v, null);
  });
});

// --- 1.5 maybeUpdateBanner orchestration ----------------------------------
describe('maybeUpdateBanner', () => {
  // Build opts with a unique session marker dir per call so session de-dup does
  // not leak across tests. We override the session marker via tmpdir + a unique
  // sessionId env so each test starts un-marked.
  function baseOpts(over = {}) {
    return {
      now: 2 * DAY_MS,
      cacheDir: fs.mkdtempSync(path.join(tmp, 'cache-')),
      installedVersion: '3.49.0',
      sessionId: `sess-${Math.random().toString(36).slice(2)}`,
      ...over,
    };
  }

  it('returns a banner naming the new and current versions plus an upgrade command when latest > installed', async () => {
    const banner = await maybeUpdateBanner(baseOpts({ fetch: okFetch('3.50.0') }));
    assert.ok(banner.includes('3.50.0'), 'banner mentions the new version');
    assert.ok(banner.includes('3.49.0'), 'banner mentions the current version');
    assert.ok(/update/i.test(banner), 'banner mentions an upgrade command');
  });

  it('returns "" when installed version equals latest', async () => {
    const banner = await maybeUpdateBanner(baseOpts({ fetch: okFetch('3.49.0') }));
    assert.equal(banner, '');
  });

  it('returns "" when installed version is ahead of latest', async () => {
    const banner = await maybeUpdateBanner(
      baseOpts({ installedVersion: '3.50.0', fetch: okFetch('3.49.0') })
    );
    assert.equal(banner, '');
  });

  it('returns "" and does not throw when the fetch shim errors', async () => {
    let banner;
    await assert.doesNotReject(async () => {
      banner = await maybeUpdateBanner(
        baseOpts({
          fetch: async () => {
            throw new Error('offline');
          },
        })
      );
    });
    assert.equal(banner, '');
  });

  it('returns "" for a malformed fetched version', async () => {
    const banner = await maybeUpdateBanner(baseOpts({ fetch: okFetch('not-a-version') }));
    assert.equal(banner, '');
  });

  it('uses a fresh (<24h) cache entry and does NOT call the fetch shim', async () => {
    const opts = baseOpts({ now: 5 * DAY_MS });
    writeCache(opts.cacheDir, { latest: '3.50.0', fetchedAt: 5 * DAY_MS - 1000 });
    let called = false;
    opts.fetch = async () => {
      called = true;
      return { status: 200, body: makeMarketplaceBody('9.9.9') };
    };
    const banner = await maybeUpdateBanner(opts);
    assert.equal(called, false, 'fetch must not be called when cache is fresh');
    assert.ok(banner.includes('3.50.0'), 'banner uses the cached latest version');
  });

  it('re-fetches when the cache entry is stale (>24h) and rewrites the cache', async () => {
    const now = 5 * DAY_MS;
    const opts = baseOpts({ now });
    writeCache(opts.cacheDir, { latest: '3.49.5', fetchedAt: now - 2 * DAY_MS });
    let called = false;
    opts.fetch = async () => {
      called = true;
      return { status: 200, body: makeMarketplaceBody('3.51.0') };
    };
    const banner = await maybeUpdateBanner(opts);
    assert.equal(called, true, 'stale cache must trigger a re-fetch');
    assert.ok(banner.includes('3.51.0'), 'banner uses the freshly fetched version');
    const written = readCache(opts.cacheDir);
    assert.equal(written.latest, '3.51.0', 'cache rewritten with the new version');
    assert.equal(written.fetchedAt, now, 'cache stamped with the current now');
  });

  it('returns "" without fetching when WORK_DISABLE_UPDATE_CHECK=1', async () => {
    process.env.WORK_DISABLE_UPDATE_CHECK = '1';
    let called = false;
    const banner = await maybeUpdateBanner(
      baseOpts({
        fetch: async () => {
          called = true;
          return { status: 200, body: makeMarketplaceBody('3.50.0') };
        },
      })
    );
    assert.equal(banner, '');
    assert.equal(called, false, 'opt-out must short-circuit before fetching');
  });

  it('does not re-check within the same session (second call returns "" and does not fetch)', async () => {
    const sessionId = 'sticky-session';
    const cacheDir = fs.mkdtempSync(path.join(tmp, 'cache-'));
    const markerDir = fs.mkdtempSync(path.join(tmp, 'marker-'));
    const first = await maybeUpdateBanner({
      now: 2 * DAY_MS,
      cacheDir,
      markerDir,
      installedVersion: '3.49.0',
      sessionId,
      fetch: okFetch('3.50.0'),
    });
    assert.ok(first.includes('3.50.0'), 'first call shows the banner');

    let called = false;
    const second = await maybeUpdateBanner({
      now: 2 * DAY_MS,
      cacheDir: fs.mkdtempSync(path.join(tmp, 'cache2-')),
      markerDir,
      installedVersion: '3.49.0',
      sessionId,
      fetch: async () => {
        called = true;
        return { status: 200, body: makeMarketplaceBody('3.50.0') };
      },
    });
    assert.equal(second, '', 'second call within the session is suppressed');
    assert.equal(called, false, 'second call does not fetch');
  });

  it('never throws even when opts is empty', async () => {
    let banner;
    await assert.doesNotReject(async () => {
      banner = await maybeUpdateBanner({});
    });
    assert.equal(typeof banner, 'string');
  });
});
