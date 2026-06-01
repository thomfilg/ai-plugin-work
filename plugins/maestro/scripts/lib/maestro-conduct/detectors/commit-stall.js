/**
 * detectors/commit-stall.js
 *
 * Informational signal for the implement phase: warn when no commits
 * have landed in the worktree for COMMIT_STALL_MIN minutes.
 *
 * Does NOT itself trigger a nudge; the main loop pairs this with
 * phase-stall to enrich alerts.
 */
const { spawnSync } = require('child_process');

const COMMIT_STALL_MIN = parseInt(process.env.COMMIT_STALL_MIN || '30', 10);

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

function detect({ worktree }) {
  if (!worktree) return { hit: false };
  const mins = minutesSinceLastCommit(worktree);
  if (mins < COMMIT_STALL_MIN) return { hit: false };
  return { hit: true, kind: 'commit-stall', mins };
}

module.exports = { name: 'commitStall', detect };
