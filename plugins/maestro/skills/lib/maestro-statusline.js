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
 * chats.
 *
 * Each live ticket carries a severity-colored status glyph (from the conductor's
 * per-ticket markers) plus a runtime-heat badge, so the operator sees which
 * agent is working, asking, nudged, or dead — without opening a pane. The pure
 * status/heat/format logic lives in maestro-statusline-lib.js (unit-tested);
 * this file is the tmux + marker-store I/O and wiring.
 *
 * Configurable via env (all optional):
 *   MAESTRO_STATUSLINE_GLYPHS  emoji|text   glyph set (default emoji)
 *   MAESTRO_HEAT_CLOCK         age|stall    what the heat badge times (default age)
 *   MAESTRO_HEAT_WARN_MIN/HOT_MIN/MAX_MIN/PIN_MIN  heat band boundaries (30/45/60/90)
 *   SILENCE_LIMIT_SEC          working→stalled threshold (default 300, shared w/ conductor)
 *   MAESTRO_NUDGE_WINDOW_SEC   restart/dead-end recency (default 1800)
 *   MAESTRO_OVERLAY_FRESH_SEC  question re-alert freshness (default 300)
 *   MAESTRO_STUCK_SANITY_SEC   stuck-input max age guard (default 43200)
 *   COLORTERM=truecolor        enables the 24-bit heat gradient (else 256-color)
 *   MAESTRO_NS                 per-namespace marker/manifest store
 * Run with `--legend` to print the glyph legend and exit.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const lib = require('./maestro-statusline-lib');

const {
  readConfig,
  markerDir,
  sessionsDir,
  resolveTicketStatus,
  elapsedMinutes,
  elapsedBadge,
  renderTicketCell,
  formatSegment,
  legendLine,
} = lib;

const ACTIVE_DIR = path.join(os.homedir(), '.cache', 'maestro', 'active');

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
// (execFileSync = no shell). An optional "<ns>/" session-name segment (MAESTRO_NS)
// is tolerated and stripped. Returns { ids: sorted ticket ids, createdById: id ->
// tmux session_created epoch (survives auto-restarts, which reuse the session) }.
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
  const re = new RegExp('^(?:[A-Za-z0-9_-]+/)?(' + esc + '-.+)-work$');
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
  const dir = sessionsDir();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }
  const liveSet = new Set(liveIds);
  for (const f of files) {
    try {
      const mf = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
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
// stuck-input/idle-blocked-alert are keyed by the tmux SESSION (`<id>-work`);
// dead-end and pr-status are keyed by the bare ticket id (state.js call sites).
function readTicketMarkers(id, dir) {
  const s = `${id}-work`;
  return {
    question: readMarker(dir, s, 'question'),
    silence: readMarker(dir, s, 'silence'),
    restartLoop: readMarker(dir, s, 'restart-loop'),
    stuckInput: readMarker(dir, s, 'stuck-input'),
    idleBlockedAlert: readMarker(dir, s, 'idle-blocked-alert'),
    deadEnd: readMarker(dir, id, 'dead-end'),
    prStatus: readMarker(dir, id, 'pr-status'),
  };
}

function segment(m, cfg, nowSec) {
  const { ids, createdById } = liveTickets(m.prefix);
  if (!ids.length) return null;
  const info = manifestInfo(ids);
  const dir = markerDir();
  const statusById = (info && info.statusById) || {};
  const cellFor = (id) => {
    const markers = readTicketMarkers(id, dir);
    const key = resolveTicketStatus(markers, statusById[id], nowSec, cfg);
    const lastActiveAt = markers.silence && markers.silence.lastActiveAt;
    const min = elapsedMinutes(cfg, { created: createdById[id], lastActiveAt }, nowSec);
    const badge = min === null ? '' : elapsedBadge(min, cfg);
    return renderTicketCell(key, id, badge, cfg);
  };
  return formatSegment(m.prefix, ids, info, cellFor);
}

function render() {
  const session = readSession();
  if (!session) return '';
  const cfg = readConfig();
  const nowSec = Math.floor(Date.now() / 1000);
  return myOrchestrations(session)
    .map((m) => segment(m, cfg, nowSec))
    .filter(Boolean)
    .join('      |      ');
}

if (require.main === module) {
  if (process.argv.includes('--legend')) {
    process.stdout.write(legendLine(readConfig()) + '\n');
  } else {
    process.stdout.write(render());
  }
}

module.exports = {
  ...lib,
  manifestInfo,
  readTicketMarkers,
  render,
};
