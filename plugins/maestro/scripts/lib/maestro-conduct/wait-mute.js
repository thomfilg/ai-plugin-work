'use strict';

/**
 * Wait-mute counter for phase-stall.
 *
 * When `isHaltedWaitingForUser(pane)` returns true, the agent is correctly
 * paused on a human action (merge, decision). Emitting phase-stall on every
 * tick during that wait is pure noise — but emitting nothing means the
 * operator can't tell the daemon is still observing. Compromise: count the
 * cycles and emit a single log line every Nth cycle. N defaults to 60
 * (~1h at a 60s tick) and is tunable via WAIT_MUTE_LOG_EVERY.
 */
const LOG_EVERY = parseInt(process.env.WAIT_MUTE_LOG_EVERY || '60', 10);

function noteWaitingForUser({ session, phase, state, alerts }) {
  const m = state.read(session, 'wait-mute') || { count: 0 };
  m.count += 1;
  state.write(session, 'wait-mute', m);
  if (m.count % LOG_EVERY === 0) {
    alerts.log(`${session} still waiting for user (phase=${phase}) [${m.count} cycles]`);
  }
}

module.exports = { noteWaitingForUser, LOG_EVERY };
