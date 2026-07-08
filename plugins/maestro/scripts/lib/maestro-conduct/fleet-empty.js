'use strict';

/**
 * fleet-empty.js — edge-triggered fleet-vanish alarm (GH-680 review).
 *
 * The per-tick "no sessions" line is log-only now, so an unexpected N→0 drop
 * (tmux server crash, kill-server, reboot) must raise its own waking fault —
 * expected rotations (kill-during-ci / stop-condition-met / dead-end) already
 * woke the conductor when they freed their slots.
 *
 * Edge-triggered on the previous tick's -work session count. null on daemon
 * start: an unknown→0 transition is not an edge (a daemon restarted onto an
 * already-empty fleet stays quiet).
 */
const alerts = require('./alerts');

let lastWorkSessionCount = null;

function checkFleetEmpty(sessions, restartEligible) {
  const workCount = sessions.filter((s) => restartEligible(s)).length;
  if (lastWorkSessionCount > 0 && workCount === 0) {
    alerts.logFault(
      `FLEET-EMPTY — ${lastWorkSessionCount} work session(s) vanished since last tick; if no rotation alert preceded this, the tmux server may have died`,
      'fleet-empty'
    );
  }
  lastWorkSessionCount = workCount;
}

module.exports = { checkFleetEmpty };
