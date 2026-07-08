'use strict';
/**
 * maestro-statusline-lib.js — pure, tmux/fs-free logic for the fleet status
 * line: env config, per-ticket status resolution, runtime-heat coloring, and
 * cell/segment formatting. The I/O entry point (tmux + marker reads) lives in
 * maestro-statusline.js, which re-exports this module's helpers.
 *
 * Configurable via env (all optional): see maestro-statusline.js header.
 */
const path = require('path');
const os = require('os');

const NS_RE = /^[A-Za-z0-9_-]+$/;

// Basic-ANSI severity palette (universal). Orange uses a 256-color index — the
// one non-basic code, but widely supported and gracefully approximated.
const C = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  orange: '\x1b[38;5;208m',
  dim: '\x1b[90m',
  reset: '\x1b[0m',
};
const ANSI_RESET = C.reset;

// One entry per status: the emoji glyph, a recolorable text glyph, and the
// severity color used to tint the ticket id (and the text glyph in text mode).
const STATUS = {
  wedged: { emoji: '💀', text: 'x', color: C.red }, // dead-end killed / nudged past threshold
  question: { emoji: '❓', text: '?', color: C.yellow }, // blocked on an operator answer
  prBroken: { emoji: '🔴', text: '✗', color: C.red }, // PR checks failing / mergeable DIRTY
  stuck: { emoji: '✎', text: '✎', color: C.yellow }, // text unsubmitted in the composer
  nudge2: { emoji: '⚠⚠', text: '!!', color: C.orange }, // second auto-restart in the window
  nudge1: { emoji: '⚠', text: '!', color: C.yellow }, // first auto-restart in the window
  prReady: { emoji: '✅', text: '◆', color: C.green }, // PR green + mergeable — ready to merge
  stalled: { emoji: '💤', text: '◦', color: C.dim }, // alive but no activity past silence limit
  working: { emoji: '🔨', text: '●', color: C.green }, // active: worktree/tokens moving
  stopped: { emoji: '⛔', text: '■', color: C.red }, // session died / blocked
  done: { emoji: '✓', text: '✓', color: C.green },
};

// Runtime-heat hue endpoints per band (light → dark shade of one hue); band
// boundary minutes are configurable, color endpoints fixed. 256-color ramp is
// the fallback for terminals without 24-bit color.
const HEAT_FROM_TO = [
  { from: [255, 255, 180], to: [255, 214, 0] }, // yellows
  { from: [255, 200, 120], to: [255, 120, 0] }, // oranges
  { from: [255, 90, 90], to: [170, 0, 0] }, // reds (then pinned)
];
const HEAT_256_CODES = [
  [229, 226, 220],
  [214, 208, 202],
  [210, 196, 160, 124],
];

function intEnv(name, def) {
  const v = parseInt(process.env[name], 10);
  return Number.isNaN(v) ? def : v;
}

// Snapshot all env-driven knobs once so a render pass is internally consistent.
function readConfig() {
  const b = [
    intEnv('MAESTRO_HEAT_WARN_MIN', 30),
    intEnv('MAESTRO_HEAT_HOT_MIN', 45),
    intEnv('MAESTRO_HEAT_MAX_MIN', 60),
    intEnv('MAESTRO_HEAT_PIN_MIN', 90),
  ];
  return {
    glyphs: process.env.MAESTRO_STATUSLINE_GLYPHS === 'text' ? 'text' : 'emoji',
    clock: process.env.MAESTRO_HEAT_CLOCK === 'stall' ? 'stall' : 'age',
    truecolor: /^(truecolor|24bit)$/i.test(process.env.COLORTERM || ''),
    silenceLimitSec: intEnv('SILENCE_LIMIT_SEC', 300),
    nudgeWindowSec: intEnv('MAESTRO_NUDGE_WINDOW_SEC', 30 * 60),
    overlayFreshSec: intEnv('MAESTRO_OVERLAY_FRESH_SEC', 300),
    stuckSanitySec: intEnv('MAESTRO_STUCK_SANITY_SEC', 12 * 3600),
    heatBounds: b,
  };
}

// Per-namespace stores (mirror maestro-conduct/namespace.js). STATE_DIR /
// MAESTRO_SESSION_DIR override; MAESTRO_NS nests under a subdir.
function nsDir(envOverride, ...base) {
  if (process.env[envOverride]) return process.env[envOverride];
  const root = path.join(os.homedir(), ...base);
  const ns = (process.env.MAESTRO_NS || '').trim();
  return NS_RE.test(ns) ? path.join(root, ns) : root;
}
const markerDir = () => nsDir('STATE_DIR', '.cache', 'maestro-conduct');
const sessionsDir = () => nsDir('MAESTRO_SESSION_DIR', '.cache', 'maestro', 'sessions');

// `ts` is a marker timestamp (epoch sec); fresh within `win` seconds of `now`.
function freshTs(ts, win, now) {
  return typeof ts === 'number' && ts > 0 && now - ts <= win;
}

// ── runtime heat ────────────────────────────────────────────────────────────

function heatBandsFor(cfg, endpoints) {
  const b = cfg.heatBounds;
  return endpoints.map((e, i) => ({ start: b[i], end: b[i + 1], e }));
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
function heatAnsi(min, cfg) {
  if (typeof min !== 'number' || min < cfg.heatBounds[0]) return '';
  if (cfg.truecolor) {
    const { band, t } = heatBand(heatBandsFor(cfg, HEAT_FROM_TO), min);
    const [r, g, b] = [0, 1, 2].map((i) => lerp(band.e.from[i], band.e.to[i], t));
    return `\x1b[38;2;${r};${g};${b}m`;
  }
  const { band, t } = heatBand(heatBandsFor(cfg, HEAT_256_CODES), min);
  const idx = Math.min(band.e.length - 1, Math.floor(t * band.e.length));
  return `\x1b[38;5;${band.e[idx]}m`;
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
// heat floor. Pure: caller injects `min` and cfg so it is testable.
function elapsedBadge(min, cfg) {
  const label = formatElapsed(min);
  const color = heatAnsi(min, cfg);
  return color ? `${color}${label}${ANSI_RESET}` : label;
}

// Elapsed minutes the heat badge should time: session age, or (in stall mode)
// time since last activity, falling back to age when there is no heartbeat.
// Returns null when no clock source is available.
function elapsedMinutes(cfg, src, nowSec) {
  const stall =
    cfg.clock === 'stall' && typeof src.lastActiveAt === 'number' && src.lastActiveAt > 0;
  const base = stall ? src.lastActiveAt : src.created;
  if (typeof base !== 'number' || base <= 0) return null;
  return (nowSec - base) / 60;
}

// ── status resolution ───────────────────────────────────────────────────────

// Auto-restart ("nudge") escalation level — restarts[] grows once per restart;
// 0 when the last restart is outside the window (stale).
function nudgeLevelOf(m, cfg, nowSec) {
  const restarts =
    m.restartLoop && Array.isArray(m.restartLoop.restarts) ? m.restartLoop.restarts : [];
  if (!restarts.length) return 0;
  const last = restarts[restarts.length - 1];
  return freshTs(last, cfg.nudgeWindowSec, nowSec) ? restarts.length : 0;
}

// Stuck-input is presence-based: the detector CLEARS the marker the moment the
// composer clears (detectors/stuck-input.js), so its presence means "currently
// stuck". Only a generous sanity cap guards against a marker orphaned by a dead
// conductor — firstSeenAt does not refresh, so a short freshness gate would hide
// a genuinely long-stuck composer.
function stuckActive(mk, cfg, nowSec) {
  return Boolean(mk) && freshTs(mk.firstSeenAt, cfg.stuckSanitySec, nowSec);
}

// Ordered marker rules — first matching predicate wins, so each agent shows
// exactly one status, highest-severity-first. Each predicate is its own function
// (ctx = { m, nowSec, nudge, cfg }) so the dispatcher stays flat. PR state is
// persisted (lastEmittedAt marks the last TRANSITION), so trust lastState.
const STATUS_RULES = [
  {
    key: 'wedged',
    test: (c) =>
      (c.m.deadEnd &&
        c.m.deadEnd.killed &&
        freshTs(c.m.deadEnd.freedAt, c.cfg.nudgeWindowSec, c.nowSec)) ||
      c.nudge >= 3,
  },
  {
    key: 'question',
    test: (c) =>
      c.m.question &&
      freshTs(c.m.question.lastAlertAt || c.m.question.startedAt, c.cfg.overlayFreshSec, c.nowSec),
  },
  { key: 'prBroken', test: (c) => c.m.prStatus && c.m.prStatus.lastState === 'pr-broken' },
  { key: 'stuck', test: (c) => stuckActive(c.m.stuckInput, c.cfg, c.nowSec) },
  { key: 'nudge2', test: (c) => c.nudge === 2 },
  { key: 'nudge1', test: (c) => c.nudge === 1 },
  { key: 'prReady', test: (c) => c.m.prStatus && c.m.prStatus.lastState === 'pr-ready' },
];

// Working vs stalled from the silence heartbeat (lastActiveAt bumps whenever the
// pane hash or token count moves). '' when there is no heartbeat marker.
function livenessStatus(m, cfg, nowSec) {
  const s = m.silence;
  if (!s || typeof s.lastActiveAt !== 'number' || s.lastActiveAt <= 0) return '';
  return nowSec - s.lastActiveAt >= cfg.silenceLimitSec ? 'stalled' : 'working';
}

// Manifest-status fallback when no live marker has an opinion yet.
function statusFallback(status) {
  if (status === 'awaiting-merge') return 'prReady';
  if (status === 'stopped' || status === 'blocked') return 'stopped';
  if (status === 'done') return 'done';
  return 'working'; // live, in-progress, no signal yet
}

/**
 * Map a ticket's markers + manifest status to a single STATUS key (or '').
 * Highest-severity-first so one agent shows exactly one status. Pure: all
 * time-dependence flows through `nowSec` so it is deterministic under test.
 */
function resolveTicketStatus(markers, status, nowSec, cfg) {
  const m = markers || {};
  const ctx = { m, nowSec, cfg, nudge: nudgeLevelOf(m, cfg, nowSec) };
  for (const rule of STATUS_RULES) {
    if (rule.test(ctx)) return rule.key;
  }
  return livenessStatus(m, cfg, nowSec) || statusFallback(status);
}

// ── rendering ───────────────────────────────────────────────────────────────

function tint(color, s) {
  return color ? `${color}${s}${C.reset}` : s;
}

// One ticket cell: severity-colored glyph + id (+ heat badge). Emoji glyphs are
// font-colored and ignore ANSI, so in emoji mode only the id is tinted; in text
// mode the (recolorable) glyph is tinted too.
function renderTicketCell(statusKey, id, badge, cfg) {
  const s = statusKey ? STATUS[statusKey] : null;
  const color = s ? s.color : '';
  const glyph = s ? (cfg.glyphs === 'text' ? s.text : s.emoji) : '';
  const shownGlyph = cfg.glyphs === 'text' ? tint(color, glyph) : glyph;
  const head = glyph ? `${shownGlyph} ${tint(color, id)}` : tint(color, id);
  return badge ? `${head} ${badge}` : head;
}

/**
 * Render one orchestration's status-line segment. `cellFor` maps a ticket id to
 * its fully-rendered cell (glyph + id + badge). Injected so tests exercise the
 * envelope formatting without touching tmux or the marker store.
 */
function formatSegment(prefix, tickets, info, cellFor) {
  const labelled = tickets.map(cellFor).join(', ');
  if (info) {
    // Lead with progress (done/total), then active agents + pending queue.
    return `🎼 ${prefix}   ${info.done}/${info.total}✓  ▶${tickets.length} (${labelled})  ⏳${info.pending}`;
  }
  return `🎼 ${prefix}   ▶  ${tickets.length}  (${labelled})`;
}

// One-line glyph legend for `--legend`.
function legendLine(cfg) {
  return Object.entries(STATUS)
    .map(([k, s]) => `${cfg.glyphs === 'text' ? s.text : s.emoji} ${k}`)
    .join('   ');
}

module.exports = {
  C,
  STATUS,
  ANSI_RESET,
  readConfig,
  markerDir,
  sessionsDir,
  freshTs,
  heatAnsi,
  formatElapsed,
  elapsedBadge,
  elapsedMinutes,
  nudgeLevelOf,
  stuckActive,
  livenessStatus,
  resolveTicketStatus,
  renderTicketCell,
  formatSegment,
  legendLine,
};
