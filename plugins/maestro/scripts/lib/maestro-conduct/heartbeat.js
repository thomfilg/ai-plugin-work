/**
 * heartbeat.js — periodic positive summary line for the maestro daemon.
 *
 * Extracted from maestro-conduct.js so the conductor stays under the
 * max-lines-per-file gate. The HEARTBEAT keyword is the grep handle for
 * downstream tooling; the format is one line per tick window.
 */
const tmux = require('./tmux');
const state = require('./state');
const workstate = require('./workstate');

// Only -work sessions are restart-eligible / counted in active totals.
function restartEligible(session) {
  return /-work$/.test(session);
}

function collectPrFlag(prMarker, totals) {
  if (!prMarker) return null;
  if (prMarker.lastState === 'pr-ready') {
    totals.prReady++;
    return 'pr-ready';
  }
  if (prMarker.lastState === 'pr-broken') {
    totals.prBroken++;
    return 'pr-broken';
  }
  if (prMarker.lastState === 'pr-pending') {
    totals.prPending++;
    return 'pr-pending';
  }
  return null;
}

function classifySession(session, totals) {
  const tid = tmux.ticketIdFor(session);
  const ws = workstate.snapshot(tid);
  const prMarker = state.read(tid, 'pr-status');
  const wedgedMarker = state.read(session, 'restart-loop');
  const commitMarker = state.read(tid, 'commit-stall');
  const flags = [];
  const prFlag = collectPrFlag(prMarker, totals);
  if (prFlag) flags.push(prFlag);
  if (wedgedMarker && wedgedMarker.wedgedUntil && wedgedMarker.wedgedUntil > state.now()) {
    flags.push('WEDGED');
    totals.wedged++;
  }
  if (commitMarker && commitMarker.lastThreshold >= 240) {
    flags.push(`stall=${commitMarker.lastThreshold}m`);
  }
  return `${tid}(${ws.phase || '?'}${flags.length ? ',' + flags.join(',') : ''})`;
}

function buildHeartbeat(sessions) {
  const workSessions = sessions.filter(restartEligible);
  const totals = { prReady: 0, prBroken: 0, prPending: 0, wedged: 0 };
  const parts = workSessions.map((s) => classifySession(s, totals));
  return (
    `HEARTBEAT ${workSessions.length} active, ${totals.prReady} pr-ready, ${totals.prBroken} pr-broken, ${totals.prPending} pr-pending, ${totals.wedged} wedged` +
    (parts.length ? ` | ${parts.join(' ')}` : '')
  );
}

module.exports = { restartEligible, collectPrFlag, classifySession, buildHeartbeat };
