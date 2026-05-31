/**
 * detectors/commit-stall.js
 *
 * Informational signal for the implement phase: warn when no commits
 * have landed in the worktree for COMMIT_STALL_MIN minutes.
 *
 * Does NOT itself trigger a nudge; the main loop pairs this with
 * phase-stall to enrich alerts.
 */
const path = require('path');
const { execSync } = require('child_process');

const COMMIT_STALL_MIN = parseInt(process.env.COMMIT_STALL_MIN || '30', 10);

function minutesSinceLastCommit(worktree) {
  try {
    const out = execSync(`git -C ${worktree} log -1 --format=%ct 2>/dev/null`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const secs = parseInt(out, 10);
    if (!secs) return 99999;
    return Math.floor((Date.now() / 1000 - secs) / 60);
  } catch { return 99999; }
}

function detect({ worktree }) {
  if (!worktree) return { hit: false };
  const mins = minutesSinceLastCommit(worktree);
  if (mins < COMMIT_STALL_MIN) return { hit: false };
  return { hit: true, kind: 'commit-stall', mins };
}

module.exports = { name: 'commitStall', detect };
