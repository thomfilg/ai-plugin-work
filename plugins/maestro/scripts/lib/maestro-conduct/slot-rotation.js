/**
 * slot-rotation.js — low-level tmux-kill + bootstrap-next primitives shared by
 * every slot-freeing path in actions.js (CI-gate rotation, dead-end rotation,
 * stop-condition reap).
 *
 * Extracted verbatim from actions.js to keep that file under the max-lines
 * gate. Behavior is byte-identical: the functions that depend on actions.js
 * internals (maybeAutoBootstrap, alert) receive them as parameters so there is
 * no circular require back into actions.js.
 */
const { spawnSync } = require('child_process');
const tmux = require('./tmux');
const alerts = require('./alerts');
const manifest = require('./manifest');
const { findNextEligibleTask, buildNextActionInstruction } = require('./next-task');
const { purgeAlertCountsForTicket } = require('../../maestro-cleanup');

function killTicketTmux(ticket) {
  for (const suffix of ['work', 'listen']) {
    spawnSync('tmux', ['kill-session', '-t', tmux.sessionName(ticket, suffix)], {
      stdio: 'ignore',
    });
  }
}

function emitSlotFreedAlert({
  session,
  ticket,
  prNumber,
  sha,
  next,
  autoBootstrapped,
  instruction,
  alert,
}) {
  alerts.log(
    `${session} SLOT-FREED at CI gate — PR #${prNumber} sha=${(sha || '').slice(0, 7)} awaiting operator merge; tmux -work + -listen killed${
      autoBootstrapped ? `; AUTO-BOOTSTRAPPED ${next.taskId}` : ''
    }`
  );
  alert({
    session,
    ticket,
    kind: 'slot-freed',
    prNumber,
    sha,
    nextTask: next ? next.taskId : null,
    nextTopic: next ? next.topic : null,
    autoBootstrapped: !!autoBootstrapped,
    instruction,
  });
}

/**
 * killAndBootstrapNext — the single canonical "kill this ticket's tmux + try
 * to bootstrap the next pending task" primitive. Every slot-freeing path
 * (CI-gate rotation, dead-end rotation, future kinds) goes through here.
 *
 * Caller customizes only the labels: alert kind, manifest status string,
 * log prefix/suffix. Mechanics — kill, alert-count purge, manifest update,
 * findNext, maybeAutoBootstrap, emit alert — are identical.
 *
 * @returns {{ next: object|null, autoBootstrapped: boolean }}
 */
function killAndBootstrapNext({
  session,
  ticket,
  alertKind,
  manifestStatus,
  manifestNote,
  logPrefix,
  logSuffix,
  alertExtra,
  purgeCounts,
  maybeAutoBootstrap,
  alert,
}) {
  // Always kill any alive tmux sessions for this ticket — defensive against
  // resurrection by autoRestart between ticks. tmux kill-session is idempotent.
  killTicketTmux(ticket);
  if (purgeCounts) {
    try {
      purgeAlertCountsForTicket(ticket, false);
    } catch (err) {
      alerts.log(`${session} ${alertKind}: purgeAlertCountsForTicket failed: ${err.message}`);
    }
  }
  manifest.updateTaskStatus(ticket, manifestStatus, manifestNote);
  // Exclude the just-killed ticket — even if it's now `pending` and would
  // otherwise top the queue, immediately re-bootstrapping it defeats the
  // purpose of the kill. POOL-FILL will pick it back up on a later tick
  // when a different slot frees, giving the operator a real rotation.
  const next = findNextEligibleTask(ticket);
  const autoBootstrapped = !!(next && maybeAutoBootstrap(next.taskId));
  const instruction = buildNextActionInstruction({
    prefix: logPrefix,
    suffix: logSuffix || '',
    next,
    autoBootstrapped,
  });
  alerts.log(
    `${session} ${logPrefix}tmux killed, slot freed${autoBootstrapped ? `; AUTO-BOOTSTRAPPED ${next.taskId}` : ''}`
  );
  alert({
    session,
    ticket,
    kind: alertKind,
    nextTask: next ? next.taskId : null,
    nextTopic: next ? next.topic : null,
    autoBootstrapped,
    instruction,
    ...(alertExtra || {}),
  });
  return { next, autoBootstrapped };
}

module.exports = {
  killTicketTmux,
  emitSlotFreedAlert,
  killAndBootstrapNext,
};
