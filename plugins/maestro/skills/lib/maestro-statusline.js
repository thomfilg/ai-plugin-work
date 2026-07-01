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
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const ACTIVE_DIR = path.join(os.homedir(), '.cache', 'maestro', 'active');

// The Claude session Claude runs this statusLine in (session_id on stdin).
let SESSION = '';
try {
  SESSION = JSON.parse(fs.readFileSync(0, 'utf8') || '{}').session_id || '';
} catch {
  /* no stdin */
}

// Orchestrations launched by THIS session — {session, prefix} markers the
// conductor writes on start.
function myOrchestrations() {
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
      if (m && m.session === SESSION && m.prefix) out.push(m);
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

function segment(m) {
  const tickets = liveTickets(m.prefix);
  if (!tickets.length) return null;
  return `🎼 ${m.prefix}   ▶  ${tickets.length}  (${tickets.join(', ')})`;
}

function render() {
  if (!SESSION) return '';
  return myOrchestrations().map(segment).filter(Boolean).join('      |      ');
}

process.stdout.write(render());
