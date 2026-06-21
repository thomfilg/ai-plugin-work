/**
 * dead-end-rotation.js — the attempt-based dead-end recovery path, extracted
 * from actions.js to keep that file under the max-lines gate (mirrors the
 * slot-rotation.js extraction).
 *
 * The function that depends on actions.js internals (killAndBootstrapNext, the
 * thin wrapper that injects maybeAutoBootstrap + alert) is received as a
 * parameter so there is no circular require back into actions.js.
 */
const { spawnSync } = require('child_process');
const alerts = require('./alerts');
const state = require('./state');
const manifest = require('./manifest');

const DEAD_END_MAX_ATTEMPTS = parseInt(process.env.DEAD_END_MAX_ATTEMPTS || '3', 10);

// Grace window (minutes) after the attempt-1 diagnostic probe during which a
// re-emit must NOT bump attempts or kill — gives the agent time to answer the
// probe before the slot rotates. maybeEscalateToDeadEnd can re-call
// freeDeadEndSlot on consecutive ticks (question re-emit / nudges-exhausted
// re-emit); without this the second tick would immediately reach attempt 2 and
// kill, so the probe's "wait ~30s" promise never held.
const DEAD_END_PROBE_GRACE_MIN = parseInt(process.env.DEAD_END_PROBE_GRACE_MIN || '3', 10);

/**
 * freeDeadEndSlot — agent is stuck (operator didn't respond; every menu option
 * a bypass; PR has no forward path). Triggered by re-emit escalation when the
 * same alert kind fires ≥ DEAD_END_REEMITS times. Attempt-based recovery: each
 * dead-end bumps `task.attempts`; < DEAD_END_MAX_ATTEMPTS → `pending` (re-eligible),
 * ≥ DEAD_END_MAX_ATTEMPTS → `blocked` (operator must intervene). The per-tick
 * `dead-end` marker prevents duplicate kills; cleared by maybeAutoBootstrap.
 *
 * After the attempt-1 probe, a DEAD_END_PROBE_GRACE_MIN grace window is
 * enforced: re-emits that land inside the window no-op (no attempt bump, no
 * kill) so the agent has time to answer the diagnostic before the slot rotates.
 * Only a re-emit after the grace window elapses advances to attempt 2 and
 * kill+rotate.
 *
 * killAndBootstrapNext + alert are injected by the caller (actions.js) to avoid
 * a circular require.
 */
function freeDeadEndSlot({ session, ticket, kind, repeatCount, sha, killAndBootstrapNext, alert }) {
  if (process.env.AUTO_FREE_DEAD_END === '0') return false;
  const marker = state.read(ticket, 'dead-end') || {};
  if (marker.killed) return false; // already freed this lifecycle

  // Grace guard: the attempt-1 probe was already sent and we're still inside
  // the grace window — no-op WITHOUT bumping attempts or killing so the agent
  // can answer the probe first. diagnosedAt and state.now() are both unix
  // seconds, so the comparison is in seconds.
  if (marker.diagnosed && state.now() - (marker.diagnosedAt || 0) < DEAD_END_PROBE_GRACE_MIN * 60) {
    return false;
  }

  const attempts = manifest.incrementTaskAttempts(ticket);

  // incrementTaskAttempts returns 0 when the ticket isn't registered in any
  // manifest. An untracked session has no pool slot to account for, so dead-end
  // rotation does not apply — bail without probing or killing rather than fall
  // through to rotateDeadEnd and kill a session we can't attempt-account for.
  if (attempts === 0) {
    alerts.log(
      `${session} DEAD-END skipped — ticket ${ticket} not in any manifest; no attempt accounting, no rotation`
    );
    return false;
  }

  // First attempt: don't kill — ask the agent to diagnose itself first so the
  // operator can read what's actually blocking before rotating the slot.
  if (attempts === 1) {
    sendDeadEndProbe({ session, ticket, kind, repeatCount, sha, attempts, alert });
    return true;
  }

  rotateDeadEnd({ session, ticket, kind, repeatCount, sha, attempts, killAndBootstrapNext });
  return true;
}

/**
 * sendDeadEndProbe — attempt-1 path: write the diagnosed `dead-end` marker,
 * push a diagnostic prompt into the agent pane, and emit a `dead-end-probe`
 * alert telling the operator to wait for the reply. No kill, no rotation.
 */
function sendDeadEndProbe({ session, ticket, kind, repeatCount, sha, attempts, alert }) {
  state.write(ticket, 'dead-end', {
    diagnosed: true,
    diagnosedAt: state.now(),
    trigger: kind,
    attempts,
  });
  const probe = `MAESTRO DIAGNOSTIC (attempt 1/${DEAD_END_MAX_ATTEMPTS}): you have been stalled on ${kind} for ${repeatCount}+ cycles. Reply with: (1) what step/phase you are on, (2) the exact prompt or condition blocking you, (3) what input or decision you need from the operator. Do NOT take any other action.`;
  try {
    spawnSync('tmux', ['send-keys', '-t', session, probe, 'Enter'], { stdio: 'ignore' });
  } catch {}
  manifest.updateTaskStatus(
    ticket,
    'in_progress',
    `dead-end probe sent (attempt 1/${DEAD_END_MAX_ATTEMPTS}); waiting for agent reply`
  );
  alerts.log(
    `${session} DEAD-END attempt 1/${DEAD_END_MAX_ATTEMPTS} — diagnostic probe sent to agent; NO kill, NO rotation. Operator should read pane reply via tmux capture-pane.`
  );
  alert({
    session,
    ticket,
    kind: 'dead-end-probe',
    trigger: kind,
    repeatCount,
    sha,
    attempts,
    instruction: `Attempt 1/${DEAD_END_MAX_ATTEMPTS}: agent received diagnostic prompt asking what's blocking. Wait ~30s, then capture pane to read reply: \`tmux capture-pane -t ${session} -p | tail -40\`. If reply is actionable, intervene; otherwise next dead-end attempt (2/${DEAD_END_MAX_ATTEMPTS}) will rotate.`,
  });
}

/**
 * rotateDeadEnd — attempt-≥2 path: write the killed `dead-end` marker then
 * kill+rotate. Status is `blocked` once attempts hit DEAD_END_MAX_ATTEMPTS,
 * else `pending` (re-eligible for a later bootstrap).
 */
function rotateDeadEnd({
  session,
  ticket,
  kind,
  repeatCount,
  sha,
  attempts,
  killAndBootstrapNext,
}) {
  const exhausted = attempts >= DEAD_END_MAX_ATTEMPTS;
  state.write(ticket, 'dead-end', {
    killed: true,
    freedAt: state.now(),
    trigger: kind,
    attempts,
  });
  killAndBootstrapNext({
    session,
    ticket,
    alertKind: 'dead-end',
    manifestStatus: exhausted ? 'blocked' : 'pending',
    manifestNote: exhausted
      ? `dead-end after ${kind} ×${repeatCount}; ${attempts} attempts exhausted`
      : `dead-end after ${kind} ×${repeatCount}; attempt ${attempts}/${DEAD_END_MAX_ATTEMPTS}, re-eligible`,
    logPrefix: `DEAD-END ${kind} re-fired ${repeatCount}x (attempt ${attempts}/${DEAD_END_MAX_ATTEMPTS}) — `,
    alertExtra: { trigger: kind, repeatCount, sha, attempts, exhausted },
    purgeCounts: true,
  });
}

module.exports = {
  DEAD_END_MAX_ATTEMPTS,
  DEAD_END_PROBE_GRACE_MIN,
  freeDeadEndSlot,
};
