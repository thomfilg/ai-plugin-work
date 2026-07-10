'use strict';

/**
 * rewake-throttle.js — persisted re-wake backoff state for the alert wake
 * channel (GH-680, tiered per GH-698). Extracted from alerts.js to keep that
 * file under the max-lines gate.
 *
 * Every conductor wake permanently grows the transcript, so repeats of the
 * SAME pending alert must not each cost a model turn. Two tiers (GH-698):
 *   BLOCKING (ACTION_REQUIRED kinds — the agent is waiting on the operator):
 *     first emission wakes immediately; repeats re-wake on a FLAT
 *     BLOCKING_REWAKE_MIN cadence. Exponential decay is the wrong curve for
 *     "a human hasn't looked yet" — attention must stay steady, not decay to
 *     once-every-4-hours (a 30→240m doubling series is exactly how an
 *     idle-blocked agent sat a full night unseen).
 *   COSMETIC (everything else — spinner-hang, no-progress, faults): first
 *     emission wakes; repeats back off exponentially (PENDING_REWAKE_MIN,
 *     doubling per re-wake, capped at PENDING_REWAKE_MAX_MIN).
 * Nothing is lost: every repeat still lands in the jsonl + tmux pane + banner
 * re-fire — the throttle only bounds how often an UNHANDLED alert re-bills
 * the context window. PENDING_REWAKE_MIN=0 or CONDUCT_WAKE_EVENTS=all
 * restores wake-on-every-repeat.
 */
const fs = require('fs');
const path = require('path');
const namespace = require('./namespace');

const STATE_DIR = namespace.stateDir();
const THROTTLE_FILE = path.join(STATE_DIR, '_wake-throttle.json');

function rewakeMinutes() {
  const n = parseInt(process.env.PENDING_REWAKE_MIN || '30', 10);
  return Number.isFinite(n) && n >= 0 ? n : 30;
}
function blockingRewakeMinutes() {
  const n = parseInt(process.env.BLOCKING_REWAKE_MIN || '5', 10);
  return Number.isFinite(n) && n >= 0 ? n : 5;
}
function rewakeMaxMinutes() {
  const n = parseInt(process.env.PENDING_REWAKE_MAX_MIN || '240', 10);
  return Number.isFinite(n) && n > 0 ? n : 240;
}
function loadThrottle() {
  try {
    const obj = JSON.parse(fs.readFileSync(THROTTLE_FILE, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}
function saveThrottle(map) {
  try {
    // Hygiene: drop entries idle for 2× the max backoff — keys rotate with
    // sha/phase so stale ones would otherwise accumulate forever.
    const horizon = 2 * rewakeMaxMinutes() * 60 * 1000;
    const now = Date.now();
    for (const k of Object.keys(map)) {
      if (!map[k] || now - (map[k].lastWakeAt || 0) > horizon) delete map[k];
    }
    fs.mkdirSync(STATE_DIR, { recursive: true });
    // tmp+rename so a torn read can never wipe sibling backoff state.
    const tmp = `${THROTTLE_FILE}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(map));
    fs.renameSync(tmp, THROTTLE_FILE);
  } catch {}
}

/**
 * Next backoff window for a key. Blocking kinds never decay: the reminder
 * cadence stays flat until the operator acts. Cosmetic kinds double per
 * re-wake so a 12h run stays affordable.
 */
function nextBackoffFor(entry, blocking, baseMin) {
  if (blocking || !entry) return baseMin;
  return Math.min(entry.backoffMin * 2, rewakeMaxMinutes());
}

/**
 * Decide whether this emission of `key` may hit the wake channel, and record
 * the wake when it does. First emission always wakes. Fail-open: any state
 * error allows the wake (losing a wake is worse than paying one).
 *
 * @param {string} key alertKey(obj) or a synthetic `_fault|…` key
 * @param {{ blocking?: boolean, firehose?: boolean }} [opts] blocking selects
 *   the flat BLOCKING_REWAKE_MIN tier; firehose (CONDUCT_WAKE_EVENTS=all)
 *   bypasses the throttle entirely.
 * @returns {boolean} true when this emission should wake
 */
function rewakeGate(key, opts) {
  const blocking = !!(opts && opts.blocking);
  const baseMin = blocking ? blockingRewakeMinutes() : rewakeMinutes();
  if (baseMin === 0) return true; // throttle disabled for this tier
  if (rewakeMinutes() === 0) return true; // PENDING_REWAKE_MIN=0 disables globally
  if (opts && opts.firehose) return true; // operator asked for everything
  try {
    const map = loadThrottle();
    const now = Date.now();
    const entry = map[key];
    if (entry && now - entry.lastWakeAt < entry.backoffMin * 60 * 1000) {
      return false; // still inside the backoff window — logged, not woken
    }
    map[key] = { lastWakeAt: now, backoffMin: nextBackoffFor(entry, blocking, baseMin) };
    saveThrottle(map);
    return true;
  } catch {
    return true;
  }
}

/** Clear the throttle entry for a key so a fresh incident re-wakes immediately. */
function resetThrottle(key) {
  try {
    const map = loadThrottle();
    if (key in map) {
      delete map[key];
      saveThrottle(map);
    }
  } catch {}
}

/** Delete every key with `prefix` from a persisted map. True when any was removed. */
function purgeKeysWithPrefix(load, save, prefix) {
  try {
    const map = load();
    let touched = false;
    for (const k of Object.keys(map)) {
      if (k.startsWith(prefix)) {
        delete map[k];
        touched = true;
      }
    }
    if (touched) save(map);
    return touched;
  } catch {
    return false;
  }
}

/** Purge every throttle entry whose key starts with `prefix` (GH-698 resolve). */
function purgePrefix(prefix) {
  return purgeKeysWithPrefix(loadThrottle, saveThrottle, prefix);
}

module.exports = { rewakeGate, resetThrottle, purgeKeysWithPrefix, purgePrefix };
