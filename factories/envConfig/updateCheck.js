'use strict';

/**
 * updateCheck.js — non-blocking version-update banner (GH-314).
 *
 * Design: the SessionStart hook ONLY reads the cache — it never touches the
 * network. When the cache is stale (>TTL) the hook spawns a detached
 * `--refresh` child and exits immediately; the banner (if any) appears from
 * the refreshed cache on the next session. Offline refreshes write a
 * null-latest cache entry so nothing retries more than once per TTL.
 *
 * Latest-version sources, in order: npm registry, then the marketplace git
 * remote's raw package.json (marketplace installs are not npm installs).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

/** Numeric semver compare on major.minor.patch; ignores pre-release tags. */
function compareSemver(a, b) {
  const pa = String(a)
    .replace(/^v/, '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b)
    .replace(/^v/, '')
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

function readState(cachePath) {
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return null;
  }
}

function writeState(cachePath, state) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const tmp = `${cachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, cachePath);
}

function isFresh(state, ttlMs, now) {
  return Boolean(state && state.checkedAt && now - Date.parse(state.checkedAt) < ttlMs);
}

async function fetchJson(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolve the latest published version: npm registry first, raw-git
 * package.json fallback. Returns a version string or null (offline/404).
 */
async function fetchLatestVersion({ packageName, fallbackRawUrl, fetchImpl = fetch }) {
  const npm = await fetchJson(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
    fetchImpl
  );
  if (npm && typeof npm.version === 'string') return { latest: npm.version, source: 'npm' };
  if (fallbackRawUrl) {
    const pkg = await fetchJson(fallbackRawUrl, fetchImpl);
    if (pkg && typeof pkg.version === 'string') return { latest: pkg.version, source: 'git' };
  }
  return { latest: null, source: null };
}

/** Refresh the cache (network). Called from the detached child only. */
async function refresh({ cachePath, packageName, fallbackRawUrl, fetchImpl = fetch }) {
  const { latest, source } = await fetchLatestVersion({ packageName, fallbackRawUrl, fetchImpl });
  writeState(cachePath, { checkedAt: new Date().toISOString(), latest, source });
  return { latest, source };
}

function bannerText({ packageName, current, latest, updateHint }) {
  return [
    `📦 ${packageName} v${latest} available (current: v${current})`,
    updateHint ? `   Update: ${updateHint}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Cache-only check used by the SessionStart hook.
 * Returns { banner: string|null, needsRefresh: boolean }.
 */
function check({
  cachePath,
  packageName,
  current,
  updateHint,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now(),
}) {
  const state = readState(cachePath);
  const needsRefresh = !isFresh(state, ttlMs, now);
  const banner =
    state && state.latest && compareSemver(state.latest, current) > 0
      ? bannerText({ packageName, current, latest: state.latest, updateHint })
      : null;
  return { banner, needsRefresh };
}

/** Fire-and-forget detached refresh; never blocks the calling hook. */
function spawnDetachedRefresh({ scriptPath, args = [] }) {
  const child = spawn(process.execPath, [scriptPath, '--refresh', ...args], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

module.exports = {
  DEFAULT_TTL_MS,
  compareSemver,
  readState,
  writeState,
  isFresh,
  fetchLatestVersion,
  refresh,
  bannerText,
  check,
  spawnDetachedRefresh,
};
