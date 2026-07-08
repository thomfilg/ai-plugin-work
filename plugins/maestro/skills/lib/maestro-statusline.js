#!/usr/bin/env node
'use strict';
/**
 * maestro-statusline.js — agent-free renderer for the maestro fleet status line.
 *
 * Renders from the conductor's LIVE view — the tmux `<prefix>-<ticket>-work`
 * sessions — so it works for ANY maestro orchestration (with or without a
 * session manifest). Scoped to the launching Claude session via a marker the
 * conductor writes (~/.cache/maestro/active/<session>.json = {session, prefix}),
 * so each orchestrator session shows only the fleet it launched — never other
 * chats. No global pin (which only one session could ever win).
 *
 * Per-agent status: each live ticket is prefixed with a glyph derived from the
 * conductor's per-ticket markers under ~/.cache/maestro-conduct/ (question,
 * silence heartbeat, restart-loop nudges, dead-end, stuck-input, pr-status), so
 * the operator can see at a glance which agent is working, asking, nudged, or
 * dead — without opening a single pane. Pure/exported helpers keep the icon
 * logic unit-testable without tmux or a live conductor.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ACTIVE_DIR = path.join(os.homedir(), '.cache', 'maestro', 'active');
const SESSIONS_DIR = path.join(os.homedir(), '.cache', 'maestro', 'sessions');

// Per-ticket conductor markers live under the same store state.js writes to.
// Mirror maestro-conduct/namespace.stateDir() so a MAESTRO_NS run reads its own
// per-namespace markers, and STATE_DIR (tests) always wins.
const NS_RE = /^[A-Za-z0-9_-]+$/;
function markerDir() {
  if (process.env.STATE_DIR) return process.env.STATE_DIR;
  const base = path.join(os.homedir(), '.cache', 'maestro-conduct');
  const ns = (process.env.MAESTRO_NS || '').trim();
  return NS_RE.test(ns) ? path.join(base, ns) : base;
}

// Freshness windows (seconds). Markers persist on disk after the condition
// clears, so a timestamp gate keeps a stale question/heartbeat from rendering a
// false status. Defaults mirror the conductor's own thresholds.
const OVERLAY_FRESH_SEC = 300; // question / stuck-input re-alert cadence
const NUDGE_WINDOW_SEC = 30 * 60; // restart-loop / dead-end recency (RESTART_WINDOW_MIN)
const SILENCE_LIMIT_SEC = 300; // stall threshold (silence DEFAULT_SILENCE_LIMIT_SEC)

// Single glyph per ticket, highest-severity-first (see resolveTicketIcon).
const ICON = {
  wedged: '💀', // dead-end killed, or nudged past the restart-loop threshold
  question: '❓', // blocked on an operator answer
  prBroken: '🔴', // PR checks failing / mergeable DIRTY
  stuck: '✎', // text sitting unsubmitted in the composer
  nudge2: '⚠⚠', // second auto-restart in the window
  nudge1: '⚠', // first auto-restart in the window
  prReady: '✅', // PR green + mergeable — ready to merge
  stalled: '💤', // alive session but no activity past the silence limit
  working: '🔨', // active: worktree/tokens moving
  stopped: '⛔', // session died / blocked
  done: '✓',
};

// The Claude session Claude runs this statusLine in (session_id on stdin). Read
// lazily so `require()`ing this module (tests) never blocks on fd 0.
function readSession() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8') || '{}').session_id || '';
  } catch {
    return '';
  }
}

// Orchestrations launched by THIS session — {session, prefix} markers the
// conductor writes on start.
function myOrchestrations(session) {
  let files = [];
  try {
    files = fs.readdirSync(ACTIVE_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const m = JSON.parse(fs.readFileSync(path.join(ACTIVE_DIR, f), 'utf8'));
      if (m && m.session === session && m.prefix) out.push(m);
    } catch {
      /* skip unreadable marker */
    }
  }
  return out;
}

// Live agent tickets for a prefix, from tmux `<prefix>-<ticket>-work` sessions
// (execFileSync = no shell). One entry per ticket; helper -dev/-listen ignored.
function liveTickets(prefix) {
  let out = '';
  try {
    out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  const esc = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^(' + esc + '-.+)-work$');
  const seen = new Set();
  for (const line of out.split('\n')) {
    const m = line.match(re);
    if (m) seen.add(m[1]);
  }
  return [...seen].sort();
}

// Manifest counts + per-task status for the topic whose tasks overlap the live
// tmux tickets. Returns {total, done, pending, statusById} or null.
function manifestInfo(liveIds) {
  if (!liveIds.length) return null;
  let files = [];
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  const liveSet = new Set(liveIds);
  for (const f of files) {
    try {
      const mf = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'));
      const tasks = Array.isArray(mf.tasks) ? mf.tasks : [];
      if (!tasks.some((t) => liveSet.has(t.id))) continue;
      const statusById = {};
      for (const t of tasks) if (t && t.id) statusById[t.id] = t.status;
      return {
        total: tasks.length,
        done: tasks.filter((t) => t.status === 'done').length,
        pending: tasks.filter((t) => t.status === 'pending').length,
        statusById,
      };
    } catch {
      /* skip unreadable manifest */
    }
  }
  return null;
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function readMarker(dir, key, kind) {
  // Flatten any "<ns>/" segment — the store is already per-namespace (state.js).
  const flat = String(key).replace(/^.*\//, '');
  return readJson(path.join(dir, `${flat}.${kind}.json`));
}

// The markers the conductor writes per ticket. Silence/question/restart-loop/
// stuck-input are keyed by the tmux SESSION (`<id>-work`); dead-end and
// pr-status are keyed by the bare ticket id (see state.js call sites).
function readTicketMarkers(id, dir) {
  const s = `${id}-work`;
  return {
    question: readMarker(dir, s, 'question'),
    silence: readMarker(dir, s, 'silence'),
    restartLoop: readMarker(dir, s, 'restart-loop'),
    stuckInput: readMarker(dir, s, 'stuck-input'),
    deadEnd: readMarker(dir, id, 'dead-end'),
    prStatus: readMarker(dir, id, 'pr-status'),
  };
}

/**
 * Map a ticket's markers + manifest status to a single status glyph.
 * Highest-severity-first so one agent shows exactly one icon. Pure: all
 * time-dependence flows through `nowSec` so it is deterministic under test.
 */
function resolveTicketIcon(markers, status, nowSec) {
  const m = markers || {};
  const fresh = (ts, win) => typeof ts === 'number' && ts > 0 && nowSec - ts <= win;

  // Auto-restart ("nudge") escalation — restarts[] grows once per restart.
  const restarts =
    m.restartLoop && Array.isArray(m.restartLoop.restarts) ? m.restartLoop.restarts : [];
  const lastRestart = restarts.length ? restarts[restarts.length - 1] : 0;
  const nudgeLevel = fresh(lastRestart, NUDGE_WINDOW_SEC) ? restarts.length : 0;

  const killed = m.deadEnd && m.deadEnd.killed && fresh(m.deadEnd.freedAt, NUDGE_WINDOW_SEC);
  if (killed || nudgeLevel >= 3) return ICON.wedged;

  if (m.question && fresh(m.question.lastAlertAt || m.question.startedAt, OVERLAY_FRESH_SEC)) {
    return ICON.question;
  }
  // PR state is persisted (lastEmittedAt marks the last TRANSITION, not the last
  // check), so trust lastState directly rather than gating on freshness.
  if (m.prStatus && m.prStatus.lastState === 'pr-broken') return ICON.prBroken;
  if (m.stuckInput && fresh(m.stuckInput.firstSeenAt, OVERLAY_FRESH_SEC)) return ICON.stuck;

  if (nudgeLevel === 2) return ICON.nudge2;
  if (nudgeLevel === 1) return ICON.nudge1;

  if (m.prStatus && m.prStatus.lastState === 'pr-ready') return ICON.prReady;

  // Working vs stalled from the silence heartbeat (lastActiveAt bumps whenever
  // the pane hash or token count moves).
  if (m.silence && typeof m.silence.lastActiveAt === 'number' && m.silence.lastActiveAt > 0) {
    return nowSec - m.silence.lastActiveAt >= SILENCE_LIMIT_SEC ? ICON.stalled : ICON.working;
  }

  // Manifest-status fallbacks when no live marker has an opinion yet.
  if (status === 'awaiting-merge') return ICON.prReady;
  if (status === 'stopped' || status === 'blocked') return ICON.stopped;
  if (status === 'done') return ICON.done;
  return ICON.working; // live, in-progress, no signal yet
}

/**
 * Render one orchestration's status-line segment. `iconFor` maps a ticket id to
 * its status glyph (or '' for none). Kept pure/injected so tests exercise the
 * formatting without touching tmux or the marker store.
 */
function formatSegment(prefix, tickets, info, iconFor) {
  const labelled = tickets
    .map((id) => {
      const icon = iconFor(id);
      return icon ? `${icon} ${id}` : id;
    })
    .join(', ');
  if (info) {
    // Lead with progress (done/total), then active agents + pending queue.
    return `🎼 ${prefix}   ${info.done}/${info.total}✓  ▶${tickets.length} (${labelled})  ⏳${info.pending}`;
  }
  return `🎼 ${prefix}   ▶  ${tickets.length}  (${labelled})`;
}

function segment(m) {
  const tickets = liveTickets(m.prefix);
  if (!tickets.length) return null;
  const info = manifestInfo(tickets);
  const dir = markerDir();
  const nowSec = Math.floor(Date.now() / 1000);
  const statusById = (info && info.statusById) || {};
  const iconFor = (id) => resolveTicketIcon(readTicketMarkers(id, dir), statusById[id], nowSec);
  return formatSegment(m.prefix, tickets, info, iconFor);
}

function render() {
  const session = readSession();
  if (!session) return '';
  return myOrchestrations(session).map(segment).filter(Boolean).join('      |      ');
}

if (require.main === module) {
  process.stdout.write(render());
}

module.exports = {
  ICON,
  OVERLAY_FRESH_SEC,
  NUDGE_WINDOW_SEC,
  SILENCE_LIMIT_SEC,
  markerDir,
  manifestInfo,
  readTicketMarkers,
  resolveTicketIcon,
  formatSegment,
  render,
};
