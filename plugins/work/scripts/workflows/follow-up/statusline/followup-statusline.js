#!/usr/bin/env node
'use strict';
/**
 * followup-statusline.js — agent-free renderer for the /follow-up status bar.
 *
 * Reads the live progress files monitor.js writes each CI-wait poll
 * (~/.cache/followup/live/<ticket>.json) and prints one compact line per
 * actively-running follow-up. No agent, no polling — Claude Code re-runs the
 * parent .sh on its refreshInterval and shows stdout.
 *
 * Scoping: by Claude session. Each live file records the session that launched
 * its /follow-up (CLAUDE_CODE_SESSION_ID); this renders a line ONLY in that
 * session — never other open chats. Freshness-gated too, so a finished/idle
 * follow-up ages out (and follow-up-next deletes the file on completion).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

// Show while a follow-up is in progress. follow-up-next deletes the file on
// completion, so this window is only a crash/abandon safety net — it must be
// long enough to span the gaps between steps (an agent fixing CI can take many
// minutes between monitor polls), or the bar would flicker out mid-run.
const FRESH_MS = 30 * 60 * 1000; // 30 min

// The session Claude runs this statusLine in (session_id on stdin). An entry
// shows only when it was launched by this same session.
let SESSION = '';
try {
  SESSION = JSON.parse(fs.readFileSync(0, 'utf8') || '{}').session_id || '';
} catch {
  /* no stdin */
}

function liveEntries() {
  const dir = path.join(os.homedir(), '.cache', 'followup', 'live');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const now = Date.now();
  const out = [];
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      if (now - fs.statSync(p).mtimeMs > FRESH_MS) continue;
      out.push(JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch {
      /* skip unreadable/partial */
    }
  }
  return out;
}

function segment(e) {
  const label = e.pr ? `#${e.pr}` : e.ticket || 'pr';
  const bits = [`🔄 follow-up ${label}`];
  if (e.step) bits.push(e.step);
  if (e.status) bits.push(e.status);
  return bits.join('   ·   ');
}

function render() {
  if (!SESSION) return ''; // can't attribute → show nothing (never leak to other chats)
  return liveEntries()
    .filter((e) => e.session === SESSION)
    .map(segment)
    .join('      |      ');
}

process.stdout.write(render());
