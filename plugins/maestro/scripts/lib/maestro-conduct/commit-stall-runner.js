'use strict';

/**
 * commit-stall-runner.js — per-tick commit-stall handling (GH-698). Extracted
 * from maestro-conduct.js to keep that file under the max-lines gate.
 *
 * Low threshold crossings stay log-only (info per conduct SKILL — they surface
 * in the logfile + heartbeat flags). Crossings at/above COMMIT_STALL_WAKE_MIN
 * are waking alerts: an 8h no-commit stall used to surface only in the
 * logfile, with the operator never woken.
 */
const alerts = require('./alerts');
const actions = require('./actions');
const commitStall = require('./detectors/commit-stall');

// 0 disables the promotion (every crossing stays log-only, pre-698 behavior).
const COMMIT_STALL_WAKE_MIN = parseInt(process.env.COMMIT_STALL_WAKE_MIN || '240', 10);

function runCommitStallDetector(ctx, { restartEligible }) {
  // Helpers can't commit; only -work meaningfully stalls on commits.
  if (!restartEligible(ctx.session)) return;
  // detector handles its own dedup + marker — only "hits" on threshold crossings.
  const cHit = commitStall.detect(ctx);
  if (!cHit.hit) return;
  if (COMMIT_STALL_WAKE_MIN <= 0 || cHit.threshold < COMMIT_STALL_WAKE_MIN) {
    alerts.log(
      `${ctx.session} commit-stall ${cHit.mins}m in phase=${ctx.phase} (threshold=${cHit.threshold}m)`,
      { kind: 'log-only' }
    );
    return;
  }
  // High-threshold crossing → waking alert (GH-698). sha carries the threshold
  // so each crossing is a fresh incident key and wakes despite any backoff the
  // previous crossing left behind.
  actions.alert({
    session: ctx.session,
    ticket: ctx.ticket,
    kind: 'commit-stall',
    phase: ctx.phase,
    skill: ctx.skill,
    elapsedMin: cHit.mins,
    threshold: cHit.threshold,
    sha: `t${cHit.threshold}`,
    instruction:
      `no commit has landed in ${cHit.mins}m (phase=${ctx.phase}). The agent may be looping on a gate, ` +
      'over-analyzing, or re-deriving work without landing it. ' +
      `Read the pane (tmux capture-pane -t ${ctx.session} -p | tail -40), find what blocks the commit, ` +
      'and unblock it — or restart the agent if its context is tangled.',
  });
}

module.exports = { runCommitStallDetector, COMMIT_STALL_WAKE_MIN };
