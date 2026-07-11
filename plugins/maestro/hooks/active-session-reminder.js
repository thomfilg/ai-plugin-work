#!/usr/bin/env node
/**
 * active-session-reminder.js — UserPromptSubmit / SessionStart hook.
 *
 * If a maestro orchestration session is active (a manifest exists under
 * MAESTRO_SESSION_DIR), inject a reminder block so the operator (or a fresh
 * conversation) doesn't:
 *   - accidentally start a second parallel orchestration
 *   - forget the priority + dependency plan
 *   - lose track of which tasks are in flight vs done vs pending
 *
 * Install (user must add to ~/.claude/settings.json — plugin can't auto-install):
 *
 *   "UserPromptSubmit": [{
 *     "matcher": ".*",
 *     "hooks": [{
 *       "type": "command",
 *       "command": "node /path/to/plugins/maestro/hooks/active-session-reminder.js"
 *     }]
 *   }]
 *
 * Fail-open: any error → exit 0 silently. Never block the prompt.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  SESSION_DIR,
  countByStatus,
  doneIdSet,
  eligibleTasks,
} = require('../scripts/lib/maestro-conduct/session-shared');
const namespace = require('../scripts/lib/maestro-conduct/namespace');
const { getRuntime } = require('../scripts/lib/runtime/index');
const { guardStdoutContext } = require('../scripts/lib/runtime/emit');

// The banner is bracket-leading ('[maestro] …'): on codex that stdout is
// sniffed as JSON, fails to parse, and the hook is marked Failed with the
// text DROPPED (GT §2.6.1 — one of the two live "invalid user prompt submit
// JSON output" failures in the WP-12 TUI probe). guardStdoutContext prepends
// a lead-in line on codex only; claude bytes are unchanged. Runtime detection
// reads the stdin payload; fail-open to {} like the config-detect hooks.
function readPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

// Pending-decision surfacing: actionable alerts younger than this window are
// re-shown on every user prompt. This is the "ask me when I'm looking at the
// screen" channel — the hook fires exactly when the user types, so decisions
// queue here instead of blocking the conductor loop on AskUserQuestion (which
// froze all agent-event processing until the human answered). Live problems
// keep re-emitting on their cooldowns, so they stay inside the window;
// resolved ones age out.
const PENDING_WINDOW_MIN = parseInt(process.env.MAESTRO_PENDING_WINDOW_MIN || '90', 10);
// Every kind that can wake the conductor also re-fires here until handled —
// the banner is the safety net for a missed/compacted wake. Must equal
// DEFAULT_WAKE_KINDS in scripts/lib/maestro-conduct/alerts.js (asserted by the
// wake-kinds invariant test in scripts/__tests__/heartbeat-wake-routing.test.js).
const PENDING_KINDS = new Set([
  'question-pending',
  'nudges-exhausted',
  'wedged',
  'dead-end',
  'dead-end-probe',
  'pr-ready',
  'pr-broken',
  'pr-comments-stuck',
  'comment-loop',
  'stuck-input',
  'idle-blocked',
  'auth-broken',
  'spinner-hang',
  'no-progress',
  'kill-during-ci',
  'stop-condition-met',
  'commit-stall',
]);

function readAlertTail() {
  try {
    const fd = fs.openSync(namespace.alertFile(), 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - 64 * 1024);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch {
    return '';
  }
}

/** The parsed record, iff it is an in-window alert of a pending kind. */
function pendingAlertFrom(a, cutoff) {
  if (!a || !PENDING_KINDS.has(a.kind)) return null;
  const ts = Date.parse(a.ts || '');
  if (!ts || ts < cutoff) return null;
  return a;
}

// Banner compression (GH-680): an actionable alert surfaced verbatim once this
// session collapses to a `[REPEAT n] <id>: <first 80 chars>` one-liner on later
// prompts, cutting conductor token burn while preserving the PR #603 re-fire
// guarantee (the line still re-appears every prompt until the alert ages out).
// The shown-marker is session-scoped and lives under namespace.stateDir(); all
// marker I/O is fail-open so a read/write error simply reverts to full output.
const SHOWN_FULL = 160; // first-surface instruction slice
const SHOWN_HEAD = 80; // compressed one-liner instruction slice

/** Filesystem-safe infix for a session id. */
function safeSessionId(id) {
  return String(id).replace(/[^A-Za-z0-9_-]+/g, '-');
}

/**
 * Resolve the current session id: CLAUDE_CODE_SESSION_ID when set, else a stable
 * hash of SESSION_DIR so repeat prompts in the same orchestration share a marker.
 */
function currentSessionId() {
  const explicit = (process.env.CLAUDE_CODE_SESSION_ID || '').trim();
  if (explicit) return safeSessionId(explicit);
  return crypto.createHash('sha1').update(String(SESSION_DIR)).digest('hex').slice(0, 12);
}

/** Absolute path to the session-scoped banner shown-marker. */
function shownMarkerPath(sessionId) {
  return path.join(namespace.stateDir(), `_banner-shown-${sessionId}.json`);
}

/** Stable fingerprint for one alert occurrence: "<session|ticket>|<kind>|<ts>". */
function alertFingerprint(a) {
  return `${a.session || a.ticket}|${a.kind}|${a.ts || ''}`;
}

/** Load the shown-marker map (fingerprint → surface count). Fail-open to {}. */
function loadShownMarker(markerPath) {
  try {
    const obj = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

/** Persist the shown-marker map. Fail-open (never throws, never blocks). */
function saveShownMarker(markerPath, shown) {
  try {
    fs.mkdirSync(path.dirname(markerPath), { recursive: true });
    fs.writeFileSync(markerPath, JSON.stringify(shown));
  } catch {
    /* fail-open */
  }
}

/**
 * Render one pending-alert line: full instruction body on first surface this
 * session, a compressed `[REPEAT n]` one-liner on every subsequent surface.
 */
function renderPendingLine(a, seen) {
  const id = a.session || a.ticket;
  const instr = String(a.instruction || '');
  if (seen === 0) return `    ⚑ ${id} ${a.kind}: ${instr.slice(0, SHOWN_FULL)}`;
  return `    ⚑ [REPEAT ${seen}] ${id} ${a.kind}: ${instr.slice(0, SHOWN_HEAD)}`;
}

/** Track the newest alert-resolved ts per session|kind (GH-698). */
function noteResolutionRecord(resolved, r) {
  if (!r || r.kind !== 'alert-resolved' || !r.resolvesKind) return false;
  const ts = Date.parse(r.ts || '');
  if (ts) {
    const k = `${r.session || r.ticket}|${r.resolvesKind}`;
    if (!resolved.has(k) || ts > resolved.get(k)) resolved.set(k, ts);
  }
  return true;
}

/** Drop pending alerts whose newest occurrence predates a resolution record. */
function dropResolved(latest, resolved) {
  for (const [k, a] of latest) {
    const rts = resolved.get(k);
    if (rts && Date.parse(a.ts || '') <= rts) latest.delete(k);
  }
}

/**
 * Scan the alert tail into the newest pending alert per session|kind. The
 * alert-resolved records (GH-698) mean the conductor observed the condition
 * clear (composer emptied, prompt answered) — they retire the incident so the
 * banner stops nagging about a decision already handled; a resolved
 * stuck-input used to re-fire for its full 90m window.
 */
function collectAlertRecords(raw, cutoff) {
  const latest = new Map(); // session|kind → newest alert wins
  const resolved = new Map(); // session|kind → newest alert-resolved ts
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (noteResolutionRecord(resolved, r)) continue;
    const a = pendingAlertFrom(r, cutoff);
    if (a) latest.set(`${a.session || a.ticket}|${a.kind}`, a);
  }
  dropResolved(latest, resolved);
  return latest;
}

function pendingDecisionLines() {
  const raw = readAlertTail();
  if (!raw) return [];
  const cutoff = Date.now() - PENDING_WINDOW_MIN * 60 * 1000;
  const latest = collectAlertRecords(raw, cutoff);
  if (!latest.size) return [];

  const markerPath = shownMarkerPath(currentSessionId());
  const shown = loadShownMarker(markerPath);
  // Rebuild the marker from only the currently-live fingerprints so aged-out
  // alerts prune automatically and the file stays bounded.
  const next = {};

  const out = ['  PENDING DECISIONS (recent actionable alerts — handle or they re-fire):'];
  for (const a of latest.values()) {
    const fp = alertFingerprint(a);
    const seen = Number(shown[fp]) || 0;
    out.push(renderPendingLine(a, seen));
    next[fp] = seen + 1;
  }
  saveShownMarker(markerPath, next);
  return out;
}

try {
  if (!fs.existsSync(SESSION_DIR)) process.exit(0);
  const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith('.json'));
  if (!files.length) process.exit(0);

  const lines = [
    '[maestro] ACTIVE ORCHESTRATION SESSION(S) — do not start a parallel orchestration without checking these first:',
  ];
  for (const f of files) {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf8'));
    } catch {
      continue;
    }
    const counts = countByStatus(s.tasks);
    lines.push(
      `  • ${s.topic} — slots=${s.slots} | ` +
        `${counts.in_progress} in flight, ${counts.done}/${s.tasks.length} done, ${counts.pending} pending` +
        (counts.blocked ? `, ${counts.blocked} blocked` : '')
    );
    // Show the next 3 eligible tasks (deps resolved, sorted by priority).
    const doneIds = doneIdSet(s.tasks);
    const eligible = eligibleTasks(s.tasks).slice(0, 3);
    if (eligible.length) {
      lines.push(
        `    next eligible: ${eligible
          .map(
            (t) =>
              `${t.id}#p${t.priority}${(t.deps || []).length ? `[deps:${t.deps.join(',')}✓]` : ''}`
          )
          .join(', ')}`
      );
    }
    const blockedByDeps = s.tasks
      .filter((t) => t.status === 'pending')
      .filter((t) => (t.deps || []).some((d) => !doneIds.has(d)));
    if (blockedByDeps.length) {
      lines.push(
        `    waiting on deps: ${blockedByDeps
          .slice(0, 3)
          .map((t) => `${t.id}(needs: ${(t.deps || []).filter((d) => !doneIds.has(d)).join(',')})`)
          .join(', ')}`
      );
    }
  }
  lines.push(...pendingDecisionLines());
  lines.push(
    '  CLI: node plugins/maestro/scripts/maestro-session.js {summary|show <topic>|next <topic>|update <topic> <task> <status>|sync|clear <topic>}'
  );

  process.stdout.write(`${guardStdoutContext(getRuntime(readPayload()).name, lines.join('\n'))}\n`);
} catch {
  /* fail-open */
}
