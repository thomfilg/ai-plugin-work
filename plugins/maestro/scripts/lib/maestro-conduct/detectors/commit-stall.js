/**
 * detectors/commit-stall.js
 *
 * Informational signal for the implement phase: warn when no commits
 * have landed in the worktree for COMMIT_STALL_MIN minutes.
 *
 * Dedup contract: this detector only "hits" when the stall has crossed a
 * NEW threshold since last we asked. Thresholds are `[30, 60, 120, 240, 480]`
 * minutes by default. Without this dedup the detector fires every tick (60s),
 * producing hundreds of identical log lines that desensitize the orchestrator
 * — see SKILL.md "Daemon event vocabulary" for the contract.
 *
 * Does NOT trigger a nudge; the main loop pairs this with phase-stall.
 */
const { spawnSync } = require('child_process');
const state = require('../state');

const COMMIT_STALL_MIN = parseInt(process.env.COMMIT_STALL_MIN || '30', 10);
const COMMIT_STALL_THRESHOLDS = (process.env.COMMIT_STALL_THRESHOLDS || '30,60,120,240,480')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n >= COMMIT_STALL_MIN)
  .sort((a, b) => a - b);

function minutesSinceLastCommit(worktree) {
  const res = spawnSync('git', ['-C', worktree, 'log', '-1', '--format=%ct'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (res.status !== 0) return 99999;
  const secs = parseInt((res.stdout || '').trim(), 10);
  if (!secs) return 99999;
  return Math.floor((Date.now() / 1000 - secs) / 60);
}

/**
 * Highest threshold not exceeding `mins`. Returns 0 when below the floor.
 */
function thresholdFor(mins) {
  return COMMIT_STALL_THRESHOLDS.reduce((acc, t) => (mins >= t ? t : acc), 0);
}

function detect({ ticket, worktree }) {
  if (!worktree) return { hit: false };
  const mins = minutesSinceLastCommit(worktree);
  if (mins < COMMIT_STALL_MIN) {
    // Recovered — clear marker so the next stall starts fresh.
    if (ticket && state.read(ticket, 'commit-stall')) state.clear(ticket, 'commit-stall');
    return { hit: false };
  }
  const level = thresholdFor(mins);
  if (level === 0) return { hit: false };
  // Dedup against marker. Marker is per-ticket because the worktree (and
  // therefore commit cadence) belongs to the ticket, not the pane.
  const marker = (ticket && state.read(ticket, 'commit-stall')) || { lastThreshold: 0 };
  if (level <= marker.lastThreshold) return { hit: false };
  if (ticket) {
    state.write(ticket, 'commit-stall', { lastThreshold: level, lastAt: state.now() });
  }
  return { hit: true, kind: 'commit-stall', mins, threshold: level };
}

module.exports = { name: 'commitStall', detect, thresholdFor, COMMIT_STALL_THRESHOLDS };
