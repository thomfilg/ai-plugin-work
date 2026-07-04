/**
 * heartbeat.js — periodic positive summary line for the maestro daemon.
 *
 * Extracted from maestro-conduct.js so the conductor stays under the
 * max-lines-per-file gate. The HEARTBEAT keyword is the grep handle for
 * downstream tooling; the format is one line per tick window.
 */
const tmux = require('./tmux');
const state = require('./state');
const skillRegistry = require('./skill-registry');
const alerts = require('./alerts');

// Heartbeat: emit on state-change, with a max-staleness cap so the operator
// always gets a positive signal every HEARTBEAT_MAX_MIN even if nothing has
// changed (proves the daemon is alive). State-change beats include any of:
// activeCount, wedgedCount, prReady/prBroken/prPending counts, ticket set.
//
// HEARTBEAT_MIN was previously a hard floor that suppressed ALL beats in the
// first 15m, including real state changes — which contradicted the
// "state-change-driven" contract (review feedback). It now only rate-limits
// max-staleness (unchanged-body) beats; a real state change emits
// immediately regardless of when the last beat was.
const HEARTBEAT_MIN = parseInt(process.env.HEARTBEAT_MIN || '15', 10); // min gap between two UNCHANGED-state beats
const HEARTBEAT_MAX_MIN = parseInt(process.env.HEARTBEAT_MAX_MIN || '60', 10); // force-emit cap
let lastHeartbeatAt = 0;
let lastHeartbeatBody = '';

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

function sessionFlags(tid, session, totals) {
  const flags = [];
  const prFlag = collectPrFlag(state.read(tid, 'pr-status'), totals);
  if (prFlag) flags.push(prFlag);
  const wedgedMarker = state.read(session, 'restart-loop');
  if (wedgedMarker && wedgedMarker.wedgedUntil && wedgedMarker.wedgedUntil > state.now()) {
    flags.push('WEDGED');
    totals.wedged++;
  }
  const commitMarker = state.read(tid, 'commit-stall');
  if (commitMarker && commitMarker.lastThreshold >= 240) {
    flags.push(`stall=${commitMarker.lastThreshold}m`);
  }
  return flags;
}

function classifySession(session, totals) {
  const tid = tmux.ticketIdFor(session);
  // Phase must come from the SAME skill-registry row the detectors use — the
  // old direct workstate read showed stale /work phases ("ECHO-6249(spec)")
  // for qc-work tickets whose .work-state.json was a leftover from an
  // earlier /work run, misleading the operator.
  const skill = skillRegistry.readTicketSkill(tid);
  const row = skillRegistry.get(skill) || skillRegistry.get('work');
  const ws = row.snapshot(tid) || { phase: null };
  const flags = sessionFlags(tid, session, totals);
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

function maybeEmitHeartbeat(sessions) {
  const now = state.now();
  const body = buildHeartbeat(sessions);
  const sinceLast = lastHeartbeatAt ? now - lastHeartbeatAt : Infinity;
  const bodyChanged = body !== lastHeartbeatBody;
  const stale = sinceLast >= HEARTBEAT_MAX_MIN * 60;

  // Body changed → emit immediately (state-change-driven contract; review
  // feedback fixed: the floor used to suppress these for the first 15m).
  // Body unchanged → respect HEARTBEAT_MIN as a floor and emit only when
  // we've also hit HEARTBEAT_MAX_MIN (daemon-alive signal).
  if (bodyChanged) {
    // emit
  } else if (stale && sinceLast >= HEARTBEAT_MIN * 60) {
    // emit
  } else {
    return;
  }

  lastHeartbeatAt = now;
  lastHeartbeatBody = body;
  alerts.log(body);
}

module.exports = {
  restartEligible,
  collectPrFlag,
  classifySession,
  buildHeartbeat,
  maybeEmitHeartbeat,
};
