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

const ANSI_RESET = '\x1b[0m';

// Session-runtime "heat": how long an agent has been running, encoded as a
// colored elapsed badge. Below HEAT_MIN_MIN it stays the terminal default
// (calm); past it the badge walks through SHADES OF ONE HUE, then jumps hue at
// each band boundary — yellow deepens, then orange deepens, then red deepens.
// Each band lerps between a light and a dark shade of that hue.
const HEAT_MIN_MIN = 30;
const HEAT_BANDS = [
  { start: 30, end: 45, from: [255, 255, 180], to: [255, 214, 0] }, // yellows
  { start: 45, end: 60, from: [255, 200, 120], to: [255, 120, 0] }, // oranges
  { start: 60, end: 90, from: [255, 90, 90], to: [170, 0, 0] }, // reds (then pinned)
];
// Discrete 256-color ramp per band for terminals without 24-bit color.
const HEAT_256 = [
  { start: 30, end: 45, codes: [229, 226, 220] },
  { start: 45, end: 60, codes: [214, 208, 202] },
  { start: 60, end: 90, codes: [210, 196, 160, 124] },
];

function terminalTruecolor() {
  return /^(truecolor|24bit)$/i.test(process.env.COLORTERM || '');
}

// Pick the band covering `min` (or the last band, saturated, once past it).
function heatBand(bands, min) {
  const hit = bands.find((b) => min >= b.start && min < b.end);
  if (hit) return { band: hit, t: (min - hit.start) / (hit.end - hit.start) };
  return { band: bands[bands.length - 1], t: 1 }; // past the last band → deepest
}

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t);
}

// ANSI SGR prefix for the runtime heat at `min` minutes, or '' below the floor.
function heatAnsi(min, truecolor) {
  if (typeof min !== 'number' || min < HEAT_MIN_MIN) return '';
  if (truecolor) {
    const { band, t } = heatBand(HEAT_BANDS, min);
    const [r, g, b] = [0, 1, 2].map((i) => lerp(band.from[i], band.to[i], t));
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  const { band, t } = heatBand(HEAT_256, min);
  const idx = Math.min(band.codes.length - 1, Math.floor(t * band.codes.length));
  return `\x1b[38;5;${band.codes[idx]}m`;
}

// "33m" / "1h02m" — compact elapsed label.
function formatElapsed(min) {
  const m = Math.max(0, Math.floor(min));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h${String(rem).padStart(2, '0')}m` : `${h}h`;
}

// Colored elapsed badge (label + heat SGR + reset), or the bare label below the
// heat floor. Pure: caller injects `min` and truecolor so it is testable.
function elapsedBadge(min, truecolor) {
  const label = formatElapsed(min);
  const color = heatAnsi(min, truecolor);
  return color ? `${color}${label}${ANSI_RESET}` : label;
}

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
// (execFileSync = no shell). Returns { ids: sorted ticket ids, createdById:
// id -> tmux session_created epoch (survives auto-restarts, which reuse the
// session) } so the renderer can heat-color each agent by how long it has run.
// Helper -dev/-listen sessions are ignored.
function liveTickets(prefix) {
  let out = '';
  try {
    out = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_created}'], {
      encoding: 'utf8',
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return { ids: [], createdById: {} };
  }
  const esc = String(prefix).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('^(' + esc + '-.+)-work$');
  const seen = new Set();
  const createdById = {};
  for (const line of out.split('\n')) {
    const [name, created] = line.split('\t');
    const m = (name || '').match(re);
    if (!m) continue;
    seen.add(m[1]);
    const c = parseInt(created, 10);
    if (!Number.isNaN(c)) createdById[m[1]] = c;
  }
  return { ids: [...seen].sort(), createdById };
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

// `ts` is a marker timestamp (epoch sec); fresh within `win` seconds of `now`.
function freshTs(ts, win, now) {
  return typeof ts === 'number' && ts > 0 && now - ts <= win;
}

// Auto-restart ("nudge") escalation level — restarts[] grows once per restart;
// 0 when the last restart is outside the window (stale).
function nudgeLevelOf(m, nowSec) {
  const restarts =
    m.restartLoop && Array.isArray(m.restartLoop.restarts) ? m.restartLoop.restarts : [];
  if (!restarts.length) return 0;
  const last = restarts[restarts.length - 1];
  return freshTs(last, NUDGE_WINDOW_SEC, nowSec) ? restarts.length : 0;
}

// Ordered marker rules — first matching predicate wins, so each agent shows
// exactly one glyph, highest-severity-first. Each predicate is its own function
// (ctx = { m, nowSec, nudge }) so the dispatcher stays flat. PR state is
// persisted (lastEmittedAt marks the last TRANSITION), so trust lastState
// directly rather than gating it on freshness.
const ICON_RULES = [
  {
    icon: ICON.wedged,
    test: (c) =>
      (c.m.deadEnd &&
        c.m.deadEnd.killed &&
        freshTs(c.m.deadEnd.freedAt, NUDGE_WINDOW_SEC, c.nowSec)) ||
      c.nudge >= 3,
  },
  {
    icon: ICON.question,
    test: (c) =>
      c.m.question &&
      freshTs(c.m.question.lastAlertAt || c.m.question.startedAt, OVERLAY_FRESH_SEC, c.nowSec),
  },
  { icon: ICON.prBroken, test: (c) => c.m.prStatus && c.m.prStatus.lastState === 'pr-broken' },
  {
    icon: ICON.stuck,
    test: (c) => c.m.stuckInput && freshTs(c.m.stuckInput.firstSeenAt, OVERLAY_FRESH_SEC, c.nowSec),
  },
  { icon: ICON.nudge2, test: (c) => c.nudge === 2 },
  { icon: ICON.nudge1, test: (c) => c.nudge === 1 },
  { icon: ICON.prReady, test: (c) => c.m.prStatus && c.m.prStatus.lastState === 'pr-ready' },
];

// Working vs stalled from the silence heartbeat (lastActiveAt bumps whenever the
// pane hash or token count moves). '' when there is no heartbeat marker.
function livenessIcon(m, nowSec) {
  const s = m.silence;
  if (!s || typeof s.lastActiveAt !== 'number' || s.lastActiveAt <= 0) return '';
  return nowSec - s.lastActiveAt >= SILENCE_LIMIT_SEC ? ICON.stalled : ICON.working;
}

// Manifest-status fallback when no live marker has an opinion yet.
function statusIcon(status) {
  if (status === 'awaiting-merge') return ICON.prReady;
  if (status === 'stopped' || status === 'blocked') return ICON.stopped;
  if (status === 'done') return ICON.done;
  return ICON.working; // live, in-progress, no signal yet
}

/**
 * Map a ticket's markers + manifest status to a single status glyph.
 * Highest-severity-first so one agent shows exactly one icon. Pure: all
 * time-dependence flows through `nowSec` so it is deterministic under test.
 */
function resolveTicketIcon(markers, status, nowSec) {
  const m = markers || {};
  const ctx = { m, nowSec, nudge: nudgeLevelOf(m, nowSec) };
  for (const rule of ICON_RULES) {
    if (rule.test(ctx)) return rule.icon;
  }
  return livenessIcon(m, nowSec) || statusIcon(status);
}

/**
 * Render one orchestration's status-line segment. `iconFor` maps a ticket id to
 * its status glyph (or '' for none); `badgeFor` maps it to a colored runtime
 * badge (or '' for none). Both injected so tests exercise the formatting
 * without touching tmux or the marker store.
 */
function formatSegment(prefix, tickets, info, iconFor, badgeFor = () => '') {
  const labelled = tickets
    .map((id) => {
      const icon = iconFor(id);
      const badge = badgeFor(id);
      const left = icon ? `${icon} ${id}` : id;
      return badge ? `${left} ${badge}` : left;
    })
    .join(', ');
  if (info) {
    // Lead with progress (done/total), then active agents + pending queue.
    return `🎼 ${prefix}   ${info.done}/${info.total}✓  ▶${tickets.length} (${labelled})  ⏳${info.pending}`;
  }
  return `🎼 ${prefix}   ▶  ${tickets.length}  (${labelled})`;
}

function segment(m) {
  const { ids, createdById } = liveTickets(m.prefix);
  if (!ids.length) return null;
  const info = manifestInfo(ids);
  const dir = markerDir();
  const nowSec = Math.floor(Date.now() / 1000);
  const statusById = (info && info.statusById) || {};
  const truecolor = terminalTruecolor();
  const iconFor = (id) => resolveTicketIcon(readTicketMarkers(id, dir), statusById[id], nowSec);
  const badgeFor = (id) => {
    const created = createdById[id];
    if (!created) return '';
    return elapsedBadge((nowSec - created) / 60, truecolor);
  };
  return formatSegment(m.prefix, ids, info, iconFor, badgeFor);
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
  HEAT_MIN_MIN,
  HEAT_BANDS,
  ANSI_RESET,
  markerDir,
  manifestInfo,
  readTicketMarkers,
  resolveTicketIcon,
  heatAnsi,
  formatElapsed,
  elapsedBadge,
  formatSegment,
  render,
};
