#!/usr/bin/env node
'use strict';
/**
 * followup-statusline.js — agent-free renderer for the /follow-up status bar.
 *
 * Reads the SAME artifacts the plugin already writes — it creates NO files:
 *   - <TASKS_BASE>/<ticket>/.follow-up-orchestrator.pid  (marker, carries sessionId)
 *   - <TASKS_BASE>/<ticket>/.follow-up-state.json         (currentStep, prNumber, _ciStatusLine)
 *
 * It reuses the plugin's own detection — marker.js `findActiveMarker` — to locate
 * the active follow-up OWNED BY THIS Claude session (matched on CLAUDE_CODE_SESSION_ID),
 * so the bar shows only in the session that launched /follow-up, never other chats.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { findActiveMarker } = require(path.join(__dirname, '..', '..', 'work', 'lib', 'marker'));

const FRESH_MS = 30 * 60 * 1000; // safety net: hide an abandoned follow-up after 30 min

// OSC 8 terminal hyperlink (ctrl/cmd-click). Terminals without support render
// just the text. Bytes: ESC ] 8 ;; <url> BEL <text> ESC ] 8 ;; BEL
function hyperlink(url, text) {
  return url ? `]8;;${url}${text}]8;;` : text;
}

// PR URL from the worktree's git origin (execFileSync = no shell, no injection).
function prUrl(worktreeRoot, pr) {
  if (!worktreeRoot || !pr) return '';
  try {
    const remote = execFileSync('git', ['-C', worktreeRoot, 'remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/);
    return m ? `https://github.com/${m[1]}/${m[2]}/pull/${pr}` : '';
  } catch {
    return '';
  }
}

// The Claude session Claude runs this statusLine in (session_id on stdin).
let SESSION = '';
try {
  SESSION = JSON.parse(fs.readFileSync(0, 'utf8') || '{}').session_id || '';
} catch {
  /* no stdin */
}

// TASKS_BASE for the current project — direnv exports it into the session env.
function tasksBase() {
  if (process.env.TASKS_BASE) return process.env.TASKS_BASE;
  if (process.env.WORKTREES_BASE) return path.join(process.env.WORKTREES_BASE, 'tasks');
  return '';
}

// The follow-up state for a ticket, or null when it's finished, stale, or
// unreadable (so the bar shows nothing).
function activeState(base, ticket) {
  const stateFile = path.join(base, ticket, '.follow-up-state.json');
  let fd;
  try {
    // Open once; stat + read on the SAME descriptor so there's no
    // check-then-use gap (CodeQL file-system-race / TOCTOU).
    fd = fs.openSync(stateFile, 'r');
    if (Date.now() - fs.fstatSync(fd).mtimeMs > FRESH_MS) return null;
    const st = JSON.parse(fs.readFileSync(fd, 'utf8'));
    return st.status === 'complete' ? null : st;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function render() {
  if (!SESSION) return '';
  const base = tasksBase();
  if (!base) return '';
  // Same discovery the plugin uses under concurrent agents: only a marker owned
  // by THIS session is returned.
  const marker = findActiveMarker(base, '.follow-up-orchestrator.pid', {
    sessionId: SESSION,
    worktreeRoot: null,
  });
  if (!marker || !marker.ticket) return '';

  const st = activeState(base, marker.ticket);
  if (!st) return '';

  const label = st.prNumber
    ? hyperlink(prUrl(marker.worktreeRoot, st.prNumber), `#${st.prNumber}`)
    : marker.ticket;
  const bits = [`🔄 follow-up ${label}`];
  if (st.currentStep) bits.push(st.currentStep);
  if (st._ciStatusLine) bits.push(st._ciStatusLine);
  return bits.join('   ·   ');
}

process.stdout.write(render());
