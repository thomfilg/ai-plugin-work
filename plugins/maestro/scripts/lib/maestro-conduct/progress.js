'use strict';

/**
 * progress.js — worktree-progress signature for the conductor (GH-627 lite).
 *
 * Every heuristic detector (silence, spinner, phase-stall) measures terminal
 * ACTIVITY — pane redraws, spinner glyphs, wall-clock. None of them measure
 * PROGRESS, so a long-running-but-productive agent looks identical to a hung
 * one, and the conductor Esc-interrupts / nudges / restarts agents that were
 * mid-work (observed: qc calibration runs interrupted at 15-17m; a docker
 * build Esc'd; healthy agents dead-ended).
 *
 * This module gives the conductor a cheap, deterministic progress signal:
 * a hash over the worktree's git state —
 *   HEAD sha            (commits land)
 * + `git status --porcelain` (files appear/disappear/flip state)
 * + `git diff --stat HEAD`   (tracked-file edits change line counts)
 *
 * If the signature changes between ticks, SOMETHING in the worktree moved —
 * the agent is working even if the pane looks frozen or the spinner looks
 * stuck. If it hasn't changed for a long time while the pane looks "active"
 * (tail -f, clocks, spinner redraws), the agent may be looping in place.
 *
 * Marker: state(<ticket>, 'progress') = { sig, lastChangeAt, lastCheckAt }.
 * All consumers share one marker per ticket (the worktree belongs to the
 * ticket, not the pane).
 *
 * Fail-open contract: any git failure returns sig=null and hasFreshProgress
 * returns false — detectors then behave exactly as before this module
 * existed. Suppression only ever engages on POSITIVE evidence of change.
 */

const crypto = require('crypto');
const { spawnSync } = require('child_process');
const state = require('./state');

// How recent a signature change must be to count as "fresh progress".
// Detectors use this to suppress interrupts/nudges/restarts.
const PROGRESS_FRESH_MIN = parseInt(process.env.PROGRESS_FRESH_MIN || '10', 10);

// Per-call subprocess budget — progress checks run inside the tick, so they
// must never wedge the daemon (same posture as gh-shared's GH_CALL_TIMEOUT_MS).
const GIT_CALL_TIMEOUT_MS = parseInt(process.env.GIT_CALL_TIMEOUT_MS || '10000', 10);

function gitOut(worktree, args) {
  const res = spawnSync('git', ['-C', worktree, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: GIT_CALL_TIMEOUT_MS,
  });
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;
  return res.stdout;
}

/**
 * Compute the progress signature for a worktree, or null when git state is
 * unreadable (missing worktree, timeout, not a repo).
 */
function signature(worktree) {
  if (!worktree) return null;
  const head = gitOut(worktree, ['rev-parse', 'HEAD']);
  if (head === null) return null;
  const porcelain = gitOut(worktree, ['status', '--porcelain']);
  const diffStat = gitOut(worktree, ['diff', '--stat', 'HEAD']);
  return crypto
    .createHash('md5')
    .update(head)
    .update(porcelain === null ? '' : porcelain)
    .update(diffStat === null ? '' : diffStat)
    .digest('hex');
}

/**
 * Extract the largest "N tokens" figure from a captured pane. The Claude Code
 * status bar shows the session-total token count, which grows monotonically
 * while the model produces — a progress signal that covers the phases the git
 * signature is blind to (brief/spec/tasks planning, follow-up loops, and
 * subagent work that hasn't touched the worktree yet). Observed 2026-07-12:
 * agents in planning phases accumulated ~40 false spinner-hang/no-progress
 * alerts because only worktree mtime counted as progress.
 * Returns null when no figure is visible (pane missing, TUI redraw).
 */
function paneTokenFigure(paneText) {
  if (!paneText) return null;
  let max = null;
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(k?)\s*tokens/gi;
  for (const m of paneText.matchAll(re)) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (m[2]) n *= 1000;
    if (!Number.isFinite(n)) continue;
    if (max === null || n > max) max = n;
  }
  return max;
}

/**
 * Observe the ticket's worktree (and optionally its pane) once per tick:
 * recompute the git signature plus the pane token figure and roll the marker
 * forward. EITHER signal changing counts as progress. Returns
 *   { sig, changed, minutesSinceChange }
 * with sig=null on git failure; when git is unreadable the pane-token signal
 * still drives lastChangeAt (fail-open on suppression stays intact: consumers
 * that exempt on sig===null keep doing so). Callers should invoke this at
 * most once per (ticket, tick).
 */
function observe(ticket, worktree, paneText) {
  const sig = signature(worktree);
  const tokens = paneTokenFigure(paneText);
  if (sig === null && tokens === null)
    return { sig: null, changed: false, minutesSinceChange: Infinity };
  const now = state.now();
  const prev = state.read(ticket, 'progress');
  const sigChanged = sig !== null && (!prev || prev.sig !== sig);
  const tokensChanged = tokens !== null && (!prev || prev.paneTokens !== tokens);
  if (sigChanged || tokensChanged || !prev) {
    state.write(ticket, 'progress', {
      sig: sig !== null ? sig : (prev && prev.sig) || null,
      paneTokens: tokens !== null ? tokens : (prev && prev.paneTokens) || null,
      lastChangeAt: now,
      lastCheckAt: now,
    });
    // First sighting counts as a change: we cannot distinguish "just started"
    // from "just changed", and treating it as fresh errs on the safe side
    // (suppress interrupts right after bootstrap/restart).
    return { sig, changed: true, minutesSinceChange: 0 };
  }
  state.write(ticket, 'progress', { ...prev, lastCheckAt: now });
  return { sig, changed: false, minutesSinceChange: state.minutesSince(prev.lastChangeAt) };
}

/**
 * True when the ticket's worktree changed within `freshMin` minutes (default
 * PROGRESS_FRESH_MIN). Reads the marker maintained by observe() — call
 * observe() earlier in the same tick for an up-to-date verdict.
 */
function hasFreshProgress(ticket, freshMin = PROGRESS_FRESH_MIN) {
  const m = state.read(ticket, 'progress');
  if (!m || !m.lastChangeAt) return false;
  return state.minutesSince(m.lastChangeAt) < freshMin;
}

module.exports = {
  signature,
  observe,
  hasFreshProgress,
  paneTokenFigure,
  PROGRESS_FRESH_MIN,
  GIT_CALL_TIMEOUT_MS,
};
