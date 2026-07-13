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
 *
 * Debounced to 2 consecutive empty ticks (GH-698): tmux listings flap for a
 * single tick under load or during session rotation — a live fleet was
 * observed "vanishing" for one tick and returning the next, billing a fault
 * wake for nothing. A real server death stays empty and still alerts, one
 * tick later.
 */
const alerts = require('./alerts');

let lastWorkSessionCount = null;
let pendingVanish = null; // { from } — armed on the first empty tick

function checkFleetEmpty(sessions, restartEligible) {
  const workCount = sessions.filter((s) => restartEligible(s)).length;
  if (workCount > 0) {
    pendingVanish = null;
  } else if (pendingVanish) {
    alerts.logFault(
      `FLEET-EMPTY — ${pendingVanish.from} work session(s) vanished and stayed gone for 2 ticks; if no rotation alert preceded this, the tmux server may have died`,
      'fleet-empty'
    );
    pendingVanish = null; // fire once per vanish incident
  } else if (lastWorkSessionCount > 0) {
    pendingVanish = { from: lastWorkSessionCount };
  }
  lastWorkSessionCount = workCount;
}

module.exports = { checkFleetEmpty };
