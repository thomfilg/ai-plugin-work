#!/usr/bin/env node
'use strict';
/**
 * work-statusline.js — agent-free renderer for the /work status bar.
 *
 * Reads the SAME artifacts /work already writes — it creates NO files:
 *   - <TASKS_BASE>/<ticket>/.work.pid          (marker, carries sessionId)
 *   - <TASKS_BASE>/<ticket>/.work-state.json   (currentStep, stepStatus, …)
 *
 * It reuses /work's own detection — marker.js `findActiveMarker` — to locate the
 * run OWNED BY THIS Claude session (matched on CLAUDE_CODE_SESSION_ID), so the
 * bar shows only in the session that launched /work, never other chats.
 *
 * While the run is on `follow_up`, the line goes empty so the chained follow-up
 * bar (🔄) takes over; it returns once the run advances to `ci`. See
 * lib/render-line.js.
 */
const path = require('path');

const { findActiveMarker } = require(path.join(__dirname, '..', 'lib', 'marker'));
const { readSessionId, tasksBase } = require(
  path.join(__dirname, '..', '..', 'lib', 'statusline', 'session-scope')
);
const { readActiveState } = require(path.join(__dirname, 'lib', 'read-work-state'));
const { buildLine } = require(path.join(__dirname, 'lib', 'render-line'));

// The Claude session this statusLine runs in (session_id on stdin).
const SESSION = readSessionId();

function render() {
  if (!SESSION) return '';
  const base = tasksBase();
  if (!base) return '';
  // Same discovery /work uses under concurrent agents: only a marker owned by
  // THIS session is returned.
  const marker = findActiveMarker(base, '.work.pid', {
    sessionId: SESSION,
    worktreeRoot: null,
  });
  if (!marker || !marker.ticket) return '';

  const state = readActiveState(base, marker.ticket);
  if (!state) return '';
  return buildLine(marker.ticket, state);
}

process.stdout.write(render());
