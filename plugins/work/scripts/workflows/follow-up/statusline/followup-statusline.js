#!/usr/bin/env node
'use strict';
/**
 * followup-statusline.js — agent-free renderer for the /follow-up status bar.
 *
 * Reads the live progress files monitor.js writes each CI-wait poll
 * ($TMPDIR/followup-live-<ticket>.json) and prints one compact line per
 * actively-running follow-up. No agent, no polling — Claude Code re-runs the
 * parent .sh on its refreshInterval and shows stdout.
 *
 * Scoping: freshness only. An entry is shown while its live file is fresh (a
 * follow-up is actively polling); a finished/idle follow-up ages out or is
 * deleted on completion. Shown in whatever session is watching, since a
 * follow-up may run in a worktree agent OR be driven from the operator session.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const FRESH_MS = 120000; // a live file older than this ⇒ follow-up not actively polling

// Drain stdin (Claude passes session JSON) so the pipe from the .sh never
// blocks — the bar is freshness-scoped, not cwd-scoped.
try {
  fs.readFileSync(0, 'utf8');
} catch {
  /* no stdin */
}

function liveEntries() {
  const dir = os.tmpdir();
  let files = [];
  try {
    files = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('followup-live-') && f.endsWith('.json'));
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
  return liveEntries().map(segment).join('      |      ');
}

process.stdout.write(render());
