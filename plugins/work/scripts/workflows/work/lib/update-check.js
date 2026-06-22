'use strict';

// Non-blocking version-update banner module.
//
// Every external seam (clock, cache dir, installed-version read, HTTPS fetch,
// session marker dir) is injectable so the module is fully testable without real
// network or home-dir I/O. The public contract is "never throw": failures fall
// back to "no banner" rather than disrupting the host command.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const CACHE_FILE = 'update-check-cache.json';
const MARKETPLACE_URL =
  'https://raw.githubusercontent.com/thomfilg/claude-plugin-work/main/.claude-plugin/marketplace.json';

/**
 * Compare two strict X.Y.Z version strings.
 * @returns {-1|0|1} 1 if a > b, -1 if a < b, 0 if equal.
 */
function compareSemver(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

/** True only for a strict X.Y.Z numeric version string. */
function isValidVersion(v) {
  return typeof v === 'string' && VERSION_RE.test(v);
}

/**
 * Read the installed plugin version from a plugin.json path. With no argument,
 * falls back to this module's own plugin.json. Returns null on any failure.
 */
function readInstalledVersion(pluginJsonPath) {
  try {
    const target =
      pluginJsonPath || path.join(__dirname, '..', '..', '..', '..', '.claude-plugin', 'plugin.json');
    const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
    return parsed.version != null ? String(parsed.version) : null;
  } catch {
    return null;
  }
}

/** Read a {latest, fetchedAt} cache entry from cacheDir, or null on any failure. */
function readCache(cacheDir) {
  try {
    const raw = fs.readFileSync(path.join(cacheDir, CACHE_FILE), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Write a {latest, fetchedAt} cache entry to cacheDir. Never throws. */
function writeCache(cacheDir, entry) {
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, CACHE_FILE), JSON.stringify(entry));
  } catch {
    // Best-effort: a broken cache must not break the host command.
  }
}

/**
 * Default HTTPS transport: GET the marketplace manifest, resolve { status, body }.
 * Rejects on network error or timeout. Injected in tests.
 */
function defaultFetch(timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => {
      if (settled) return;
      settled = true;
      fn(arg);
    };
    try {
      const https = require('node:https');
      const req = https.get(MARKETPLACE_URL, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () => done(resolve, { status: res.statusCode, body }));
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('ETIMEDOUT'));
      });
      req.on('error', (err) => done(reject, err));
    } catch (err) {
      done(reject, err);
    }
  });
}

/**
 * Fetch the latest published version via the (injectable) transport. Returns a
 * validated X.Y.Z string, or null on non-200, transport error, malformed body,
 * or a version that fails the shape validator.
 */
async function fetchLatestVersion(timeoutMs, opts = {}) {
  const fetch = opts.fetch || defaultFetch;
  try {
    const res = await fetch(timeoutMs);
    if (!res || res.status !== 200) return null;
    const parsed = JSON.parse(res.body);
    const version = parsed && parsed.metadata && parsed.metadata.version;
    return isValidVersion(version) ? version : null;
  } catch {
    return null;
  }
}

/** Path of the per-session de-dup marker file. */
function sessionMarkerPath(markerDir, sessionId) {
  const dir = markerDir || os.tmpdir();
  return path.join(dir, `work-update-check.${sessionId}.marker`);
}

function format(latest, installed) {
  return (
    `A new version of work-workflow is available: ${latest} (current: ${installed}). ` +
    `Run /plugin to update.`
  );
}

/**
 * Orchestrate the update-check and return a banner string (or "" for no banner).
 *
 * Contract: NEVER throws. Honors the WORK_DISABLE_UPDATE_CHECK opt-out, de-dups
 * per session via a marker file, prefers a fresh (<24h) cache entry, otherwise
 * fetches and rewrites the cache, then compares and formats.
 */
async function maybeUpdateBanner(opts = {}) {
  try {
    if (process.env.WORK_DISABLE_UPDATE_CHECK === '1') return '';

    const now = typeof opts.now === 'number' ? opts.now : Date.now();
    const installed = opts.installedVersion || readInstalledVersion();
    if (!isValidVersion(installed)) return '';

    const sessionId = opts.sessionId || 'default';
    const markerPath = sessionMarkerPath(opts.markerDir, sessionId);
    try {
      if (fs.existsSync(markerPath)) return '';
    } catch {
      // ignore marker read failures
    }

    const cacheDir =
      opts.cacheDir || process.env.WORK_UPDATE_CHECK_CACHE_DIR || os.tmpdir();

    let latest = null;
    const cached = readCache(cacheDir);
    if (cached && isValidVersion(cached.latest) && now - cached.fetchedAt < DAY_MS) {
      latest = cached.latest;
    } else {
      latest = await fetchLatestVersion(2500, { fetch: opts.fetch });
      if (isValidVersion(latest)) {
        writeCache(cacheDir, { latest, fetchedAt: now });
      }
    }

    if (!isValidVersion(latest)) return '';

    // Mark this session as checked regardless of outcome.
    try {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(markerPath, String(now));
    } catch {
      // ignore marker write failures
    }

    return compareSemver(latest, installed) > 0 ? format(latest, installed) : '';
  } catch {
    return '';
  }
}

module.exports = {
  compareSemver,
  isValidVersion,
  readInstalledVersion,
  readCache,
  writeCache,
  fetchLatestVersion,
  maybeUpdateBanner,
};
