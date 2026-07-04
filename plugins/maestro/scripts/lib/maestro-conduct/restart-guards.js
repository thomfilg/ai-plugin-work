'use strict';

/**
 * restart-guards.js — eligibility guards and the wedged-loop declaration used
 * by actions.autoRestart().
 *
 * Extracted verbatim from actions.js (no behavior change) to keep that file
 * under the max-lines gate. These helpers decide whether a silent -work session
 * may be auto-restarted (ci-gate-freed / dead-end / missing-worktree guards),
 * resolve the skill to relaunch, and — when the restart-loop threshold is hit —
 * mark the session WEDGED and emit the alert.
 */

const fs = require('fs');
const tmux = require('./tmux');
const alerts = require('./alerts');
const state = require('./state');
const { headSha } = require('./detectors/gh-shared');
const skillRegistry = require('./skill-registry');
const { formatLogLine } = require('./detectors/silence');
// Single source of truth for the dead-end probe grace window so the
// auto-restart guard and the rotation path agree (no require cycle:
// dead-end-rotation pulls alerts/state/manifest/progress/next-task only).
const { DEAD_END_PROBE_GRACE_MIN } = require('./dead-end-rotation');

// Restart-loop guard: how many auto-restarts within RESTART_WINDOW_MIN before
// we declare the session WEDGED and stop restarting. Caller is freed of state
// management — autoRestart() owns the marker.
const RESTART_LOOP_THRESHOLD = parseInt(process.env.RESTART_LOOP_THRESHOLD || '3', 10);
const RESTART_WINDOW_MIN = parseInt(process.env.RESTART_WINDOW_MIN || '30', 10);
const WEDGED_QUIET_MIN = parseInt(process.env.WEDGED_QUIET_MIN || '60', 10);

/**
 * Declare an agent wedged: record marker, log, and emit alert. Extracted from
 * autoRestart() to keep that function under the max-lines-per-function gate.
 */
function declareWedged({ session, ticket, restarts, now, silenceSec }) {
  const wedgedUntil = now + WEDGED_QUIET_MIN * 60;
  const count = restarts.length + 1;
  state.write(session, 'restart-loop', { restarts: [...restarts, now], wedgedUntil });
  const skill = skillRegistry.readTicketSkill(ticket);
  alerts.log(
    `${formatLogLine({ ticket, skill, silenceSec, kind: 'wedged' })} ${session} WEDGED — ${count} auto-restarts in ${RESTART_WINDOW_MIN}m; suppressing restarts for ${WEDGED_QUIET_MIN}m`
  );
  const paneTail = tmux.capture(session).split('\n').slice(-50).join('\n');
  const unblockCmd = `tmux capture-pane -t ${session} -p | tail -50   # diagnose, then either fix-in-pane or kill: node plugins/maestro/scripts/maestro-cleanup.js ${ticket} --tmux`;
  alerts.alert({
    session,
    ticket,
    kind: 'wedged',
    restartsInWindow: count,
    windowMin: RESTART_WINDOW_MIN,
    quietMin: WEDGED_QUIET_MIN,
    silenceSec,
    paneTail,
    unblockCmd,
    instruction: `OPERATOR ACTION REQUIRED — agent restarted ${count}x in ${RESTART_WINDOW_MIN}m. Daemon WON'T restart for ${WEDGED_QUIET_MIN}m. RUN NOW: ${unblockCmd}. UNBLOCK-PROTOCOL: diagnose root cause from paneTail; if dead-end, kill session and bootstrap next queued. DO NOT reply with "standing by".`,
  });
}

function checkCiGateFreedGuard({ session, ticket, worktree }) {
  const ciFreed = state.read(ticket, 'ci-gate-freed');
  if (!ciFreed || !ciFreed.killed) return { skip: false };
  const currentSha = headSha(worktree);
  if (currentSha && ciFreed.sha && currentSha !== ciFreed.sha) {
    alerts.log(
      `${session} AUTO-RESTART ci-gate-freed marker cleared: HEAD moved ${(ciFreed.sha || '').slice(0, 7)} -> ${currentSha.slice(0, 7)}`
    );
    state.clear(ticket, 'ci-gate-freed');
    return { skip: false };
  }
  if (!ciFreed.skipLogged) {
    alerts.log(
      `${session} AUTO-RESTART skipped: ticket ${ticket} CI-gate-freed at sha=${(ciFreed.sha || '').slice(0, 7)}; awaiting operator merge`
    );
    state.write(ticket, 'ci-gate-freed', { ...ciFreed, skipLogged: true });
  }
  return { skip: true };
}

function checkDeadEndGuard({ session, ticket }) {
  const deadEnd = state.read(ticket, 'dead-end');
  if (!deadEnd) return { skip: false };
  if (deadEnd.killed) {
    if (!deadEnd.skipLogged) {
      alerts.log(
        `${session} AUTO-RESTART skipped: ticket ${ticket} dead-end-freed (trigger=${deadEnd.trigger || 'unknown'}); slot rotated, do not resurrect`
      );
      state.write(ticket, 'dead-end', { ...deadEnd, skipLogged: true });
    }
    return { skip: true };
  }
  // Probe pending inside the grace window: a diagnostic probe was sent and
  // the agent is being given time to reply. Auto-restarting now would wipe
  // the pane (and the reply) before the operator could read it.
  if (
    deadEnd.diagnosed &&
    state.now() - (deadEnd.diagnosedAt || 0) < DEAD_END_PROBE_GRACE_MIN * 60
  ) {
    alerts.log(
      `${session} AUTO-RESTART skipped: dead-end probe pending on ${ticket} (grace ${DEAD_END_PROBE_GRACE_MIN}m)`
    );
    return { skip: true };
  }
  return { skip: false };
}

function checkRestartGuards({ session, ticket, worktree }) {
  if (!worktree || !fs.existsSync(worktree)) {
    alerts.log(`${session} AUTO-RESTART skipped: worktree ${worktree} not found`);
    return { skip: true };
  }
  const ciGuard = checkCiGateFreedGuard({ session, ticket, worktree });
  if (ciGuard.skip) return ciGuard;
  return checkDeadEndGuard({ session, ticket });
}

// GH-514 R1: resolve skill per-call so daemon restarts honor `.maestro-skill`
// writes that happened after module load. Any regex-valid persisted skill is
// now honored as-is (the write path already validates) — the old
// whitelist-or-oracle read gate relaunched `/work` on qc-work fleets whose
// manifest lookup failed, restarting a foreign workflow on delivered tickets.
// Only a MALFORMED value falls open to /work, with a log so operators can
// spot tampering.
function resolveSkillForRestart(ticket, session) {
  const skill = skillRegistry.readTicketSkill(ticket);
  let raw = null;
  try {
    raw = fs.readFileSync(skillRegistry.ticketSkillFile(ticket), 'utf8').trim();
  } catch {
    /* missing → default, no warning */
  }
  if (raw && raw !== skill) {
    alerts.log(
      `${session} AUTO-RESTART .maestro-skill value ${JSON.stringify(raw)} is malformed — falling open to /work for ${ticket}`
    );
  }
  return skill;
}

module.exports = {
  RESTART_LOOP_THRESHOLD,
  RESTART_WINDOW_MIN,
  WEDGED_QUIET_MIN,
  declareWedged,
  checkCiGateFreedGuard,
  checkDeadEndGuard,
  checkRestartGuards,
  resolveSkillForRestart,
};
