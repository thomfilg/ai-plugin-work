'use strict';

/**
 * pretool-window — bounded per-session expectations + per-turn behavior-changed
 * dedup primitives for the heuristic divergence emitter (path A) and self-report
 * scan (path B).
 *
 * Persistence: the Claude Code dispatcher runs as a fresh Node process per hook
 * event. Module-level Maps alone would never accumulate state, so every public
 * API call round-trips through `~/.claude/synapsys/.telemetry/<sessionId>.pretool-window.json`
 * (override dir via SYNAPSYS_PRETOOL_DIR). Atomic writes via tmp + rename;
 * disabled when SYNAPSYS_TELEMETRY=0. Event-count eviction only (spec
 * §Architecture/Window). Every public function is fail-open: a thrown error
 * degrades to an empty result and never propagates into the dispatcher.
 *
 * Pattern matching: stored `expected` is treated as a regex source (the same
 * shape that drives `trigger_pretool` matching), so a `git push` expectation
 * is cleared by an observed `git push origin main`. Invalid regex sources
 * fall back to exact-string equality.
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const sessionIdLib = require('./session-id');

const DEFAULT_MAX = 32;
const DEFAULT_INTERVENING = 1;

let WINDOW_MAX = DEFAULT_MAX;
let WINDOW_INTERVENING = DEFAULT_INTERVENING;

function persistDisabled() {
  return process.env.SYNAPSYS_TELEMETRY === '0';
}

function pretoolDir() {
  if (process.env.SYNAPSYS_PRETOOL_DIR) return process.env.SYNAPSYS_PRETOOL_DIR;
  return path.join(os.homedir(), '.claude', 'synapsys', '.telemetry');
}

// Use the shared SAFE_ID regex / hashId so pretool-window buckets state into
// the same filename shape used by telemetry and inject-ledger for the same
// raw session_id. Empty/missing ids → fixed `_unknown-session` bucket.
function safeId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return '_unknown-session';
  return sessionIdLib.SAFE_ID_RE.test(sessionId) ? sessionId : sessionIdLib.hashId(sessionId);
}

function fileFor(sessionId) {
  return path.join(pretoolDir(), `${safeId(sessionId)}.pretool-window.json`);
}

function emptyState() {
  return { expectations: new Map(), dedup: new Set() };
}

function normalizeExpected(raw) {
  if (Array.isArray(raw)) return raw.filter((p) => typeof p === 'string' && p.length > 0);
  if (typeof raw === 'string' && raw.length > 0) return [raw];
  return [];
}

function deserializeExpectations(raw, target) {
  if (!raw || typeof raw !== 'object') return;
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry) continue;
    // Accept legacy `expected: <string>` and new `patterns: [<string>...]`.
    const patterns = normalizeExpected(entry.patterns || entry.expected);
    if (patterns.length === 0) continue;
    target.set(name, {
      patterns,
      ageEvents: Number.isFinite(entry.ageEvents) ? entry.ageEvents : 0,
    });
  }
}

function deserializeDedup(raw, target) {
  if (!Array.isArray(raw)) return;
  for (const name of raw) {
    if (typeof name === 'string') target.add(name);
  }
}

function loadSession(sessionId) {
  if (persistDisabled()) return emptyState();
  try {
    const file = fileFor(sessionId);
    if (!fs.existsSync(file)) return emptyState();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const state = emptyState();
    deserializeExpectations(data && data.expectations, state.expectations);
    deserializeDedup(data && data.dedup, state.dedup);
    return state;
  } catch (_e) {
    return emptyState();
  }
}

function serialize(state) {
  return {
    expectations: Object.fromEntries(state.expectations),
    dedup: Array.from(state.dedup),
  };
}

function saveSession(sessionId, state) {
  if (persistDisabled()) return;
  try {
    const dir = pretoolDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = fileFor(sessionId);
    const tmp = `${file}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(serialize(state)));
    fs.renameSync(tmp, file);
  } catch (_e) {
    // fail-open
  }
}

function deleteSession(sessionId) {
  if (persistDisabled()) return;
  try {
    const file = fileFor(sessionId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_e) {
    // fail-open
  }
}

function enforceCap(expectations) {
  while (expectations.size > WINDOW_MAX) {
    const oldestKey = expectations.keys().next().value;
    if (oldestKey === undefined) break;
    expectations.delete(oldestKey);
  }
}

function matchesPattern(pattern, observed) {
  try {
    // Mirror the matcher's `safeRegex(pattern, 'i')` so a follow-up command
    // that matches the trigger case-insensitively is treated as fulfillment,
    // not divergence.
    return new RegExp(pattern, 'i').test(observed);
  } catch (_e) {
    return pattern === observed;
  }
}

function recordExpectation(sessionId, memoryName, expectedCommand) {
  try {
    const patterns = normalizeExpected(expectedCommand);
    if (patterns.length === 0) return;
    const state = loadSession(sessionId);
    // Re-insert to mark as most recently added for LRU-style eviction.
    state.expectations.delete(memoryName);
    state.expectations.set(memoryName, { patterns, ageEvents: 0 });
    enforceCap(state.expectations);
    saveSession(sessionId, state);
  } catch (_e) {
    // fail-open
  }
}

function resolveExpectation(sessionId, observedCommand) {
  try {
    const state = loadSession(sessionId);
    if (state.expectations.size === 0) {
      return { divergent: false, expectations: [] };
    }
    // Clear every expectation that has ANY pattern matching the observed
    // command. A memory with multiple `trigger_pretool` specs only needs one
    // of them to be satisfied for the agent to be "compliant".
    const matchedNames = [];
    for (const [name, entry] of state.expectations) {
      if (entry.patterns.some((p) => matchesPattern(p, observedCommand))) {
        matchedNames.push(name);
      }
    }
    if (matchedNames.length > 0) {
      for (const name of matchedNames) state.expectations.delete(name);
      saveSession(sessionId, state);
      return { divergent: false, expectations: [] };
    }
    // No match: age every entry; entries exceeding the intervening budget are
    // reported divergent and evicted.
    const divergent = [];
    for (const [name, entry] of Array.from(state.expectations.entries())) {
      entry.ageEvents += 1;
      if (entry.ageEvents > WINDOW_INTERVENING) {
        divergent.push({ memoryName: name, expected: entry.patterns.join('|') });
        state.expectations.delete(name);
      }
    }
    saveSession(sessionId, state);
    if (divergent.length > 0) return { divergent: true, expectations: divergent };
    return { divergent: false, expectations: [] };
  } catch (_e) {
    return { divergent: false, expectations: [] };
  }
}

function evictStale(sessionId) {
  try {
    const state = loadSession(sessionId);
    enforceCap(state.expectations);
    saveSession(sessionId, state);
  } catch (_e) {
    // fail-open
  }
}

function markBehaviorChanged(sessionId, memoryName) {
  try {
    const state = loadSession(sessionId);
    if (state.dedup.has(memoryName)) return false;
    state.dedup.add(memoryName);
    saveSession(sessionId, state);
    return true;
  } catch (_e) {
    return false;
  }
}

function clearTurnDedup(sessionId) {
  try {
    const state = loadSession(sessionId);
    state.dedup.clear();
    if (state.expectations.size === 0) {
      deleteSession(sessionId);
    } else {
      saveSession(sessionId, state);
    }
  } catch (_e) {
    // fail-open
  }
}

function setWindowOverrides(opts) {
  try {
    if (opts && typeof opts.max === 'number') WINDOW_MAX = opts.max;
    if (opts && typeof opts.intervening === 'number') WINDOW_INTERVENING = opts.intervening;
  } catch (_e) {
    // fail-open
  }
}

module.exports = {
  PRETOOL_WINDOW_MAX: DEFAULT_MAX,
  PRETOOL_WINDOW_INTERVENING: DEFAULT_INTERVENING,
  recordExpectation,
  resolveExpectation,
  evictStale,
  markBehaviorChanged,
  clearTurnDedup,
  setWindowOverrides,
};
