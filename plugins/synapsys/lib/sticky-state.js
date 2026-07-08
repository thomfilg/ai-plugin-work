'use strict';

// GH-513 Task 5 — sticky-domain LRU + hysteresis store.
//
// Per-(sessionId, domain) tracking of activeStreak / quietStreak / lastSeenTs.
// - activeStreak >= STREAK_THRESHOLD flips a domain sticky.
// - quietStreak >= STREAK_THRESHOLD drops it back to non-sticky (and removes the entry).
// - Entries older than TTL_MS are evicted on load.
// - File writes are atomic via tmp + rename.
// - All load/save errors are swallowed (fail-open): callers see {} / no-op.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const STREAK_THRESHOLD = 3;
const TTL_MS = 24 * 60 * 60 * 1000;

function defaultStatePath() {
  // SYNAPSYS_HOME (set by synapsys-status / install tooling) overrides
  // the user's home so the dispatcher and the status CLI agree on which
  // sticky-state file to read. Falls back to HOME, then to os.homedir().
  const home = process.env.SYNAPSYS_HOME || process.env.HOME || os.homedir();
  return path.join(home, '.claude', 'synapsys', '.state', 'sticky-domains.json');
}

function readJsonFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function normalizeStickyEntry(entry, now) {
  if (!entry || typeof entry !== 'object') return null;
  const lastSeenTs = Number(entry.lastSeenTs) || 0;
  if (now - lastSeenTs > TTL_MS) return null; // evict
  return {
    activeStreak: Number(entry.activeStreak) || 0,
    quietStreak: Number(entry.quietStreak) || 0,
    sticky: entry.sticky === true,
    lastSeenTs,
  };
}

function normalizeSession(session, now) {
  if (!session || typeof session !== 'object') return null;
  const kept = {};
  for (const domain of Object.keys(session)) {
    const entry = normalizeStickyEntry(session[domain], now);
    if (entry) kept[domain] = entry;
  }
  return Object.keys(kept).length > 0 ? kept : null;
}

function loadStickyState({ filePath = defaultStatePath(), now = Date.now() } = {}) {
  const parsed = readJsonFile(filePath);
  if (!parsed || typeof parsed !== 'object') return {};

  const out = {};
  for (const sessionId of Object.keys(parsed)) {
    const kept = normalizeSession(parsed[sessionId], now);
    if (kept) out[sessionId] = kept;
  }
  return out;
}

function saveStickyState({ state, filePath = defaultStatePath() }) {
  try {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    try {
      fs.renameSync(tmp, filePath);
    } catch (e) {
      // Cleanup tmp on rename failure.
      try {
        fs.unlinkSync(tmp);
      } catch (_) {
        /* ignore */
      }
      throw e;
    }
  } catch (_) {
    // Fail-open.
  }
}

function nextStreak(prev, isActive) {
  const base = prev || { activeStreak: 0, quietStreak: 0, sticky: false };
  if (isActive) {
    return {
      activeStreak: (base.activeStreak || 0) + 1,
      quietStreak: 0,
      sticky: base.sticky === true,
    };
  }
  return {
    activeStreak: 0,
    quietStreak: (base.quietStreak || 0) + 1,
    sticky: base.sticky === true,
  };
}

function stepDomain(session, domain, isActive, now) {
  const stepped = nextStreak(session[domain], isActive);
  if (stepped.activeStreak >= STREAK_THRESHOLD) stepped.sticky = true;
  if (stepped.quietStreak >= STREAK_THRESHOLD) {
    delete session[domain];
    return;
  }
  session[domain] = {
    activeStreak: stepped.activeStreak,
    quietStreak: stepped.quietStreak,
    sticky: stepped.sticky,
    lastSeenTs: now,
  };
}

function updateStickyState({ state, sessionId, rawActiveSet, now = Date.now() }) {
  const next = { ...(state || {}) };
  const prevSession = (state && state[sessionId]) || {};
  const session = { ...prevSession };

  const active = rawActiveSet instanceof Set ? rawActiveSet : new Set(rawActiveSet || []);
  const domains = new Set([...Object.keys(session), ...active]);

  for (const domain of domains) {
    stepDomain(session, domain, active.has(domain), now);
  }

  if (Object.keys(session).length === 0) {
    delete next[sessionId];
  } else {
    next[sessionId] = session;
  }
  return next;
}

module.exports = {
  loadStickyState,
  saveStickyState,
  updateStickyState,
  nextStreak,
  defaultStatePath,
  STREAK_THRESHOLD,
  TTL_MS,
};
