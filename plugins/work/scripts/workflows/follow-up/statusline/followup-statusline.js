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
 * Scoping: a follow-up runs inside a specific PR worktree, so an entry is shown
 * only in the session whose cwd matches the entry's worktree (and only while
 * the file is fresh — a finished/idle follow-up ages out or is deleted).
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const FRESH_MS = 120000; // a live file older than this ⇒ follow-up not actively polling

// Session JSON on stdin (best-effort) → the session cwd, used to scope the
// follow-up line to the PR worktree it is running in.
let CTX = {};
try {
  CTX = JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
} catch {
  CTX = {};
}
const WS = CTX.workspace || {};
const CWD = CTX.cwd || WS.current_dir || WS.project_dir || '';

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
  // Only show a follow-up in the session sitting in its worktree (cwd match);
  // fall back to showing fresh entries when the host provides no cwd.
  const entries = liveEntries().filter((e) => !CWD || !e.cwd || e.cwd === CWD);
  return entries.map(segment).join('      |      ');
}

process.stdout.write(render());
