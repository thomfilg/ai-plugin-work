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
const { readSessionId, tasksBase } = require(
  path.join(__dirname, '..', '..', 'lib', 'statusline', 'session-scope')
);
const { composeStatusLine, formatElapsed } = require(
  path.join(__dirname, '..', 'lib', 'steps', 'monitor-status-line')
);

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
const SESSION = readSessionId();

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
  bits.push(...statusBits(st));
  const pending = pendingActionMarker(base, marker.ticket);
  if (pending) bits.push(pending);
  return bits.filter(Boolean).join('   ·   ');
}

// The CI summary line. When structured parts are available, recompute the
// elapsed timer NOW so it ticks on every 3s refresh — the pre-baked
// `_ciStatusLine` string carries the elapsed frozen at monitor time.
function statusBits(st) {
  if (st._ciStatusParts) {
    return [composeStatusLine(st._ciStatusParts, formatElapsed(st._monitorStartTime))];
  }
  return st._ciStatusLine ? [st._ciStatusLine] : [];
}

// ⚠ marker when the last persisted instruction is terminal (blocked/surface)
// — the workflow is waiting on the operator, not on CI.
function pendingActionMarker(base, ticket) {
  try {
    const raw = fs.readFileSync(path.join(base, ticket, '.follow-up-next.json'), 'utf8');
    const instruction = JSON.parse(raw);
    if (instruction.action === 'blocked' || instruction.action === 'surface') {
      return `⚠ ${instruction.action}`;
    }
  } catch {
    /* no persisted instruction */
  }
  return '';
}

process.stdout.write(render());
