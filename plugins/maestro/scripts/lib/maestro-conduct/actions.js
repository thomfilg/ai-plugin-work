/**
 * actions.js — what to do when a detector fires.
 *
 * Three actions, mapped from phase-registry.escalationFor():
 *   soft      → send a message into the agent prompt (no interrupt)
 *   interrupt → send Esc, wait, send message (used when soft nudge was ignored
 *               or when a spinner is clearly hung)
 *   alert     → no agent action; write to the maestro alert sink
 *
 * Nudge text is intentionally generic; the agent decides how to land
 * uncommitted work (the 'commit agent' is the orchestrator's commit-writer).
 * Avoid literal CLI strings that trip the enforce-agent-usage hook.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const tmux = require('./tmux');
const alerts = require('./alerts');
const state = require('./state');
const { headSha } = require('./detectors/gh-shared');
const manifest = require('./manifest');
const {
  findNextEligibleTask,
  findEligibleTasks,
  buildNextActionInstruction,
} = require('./next-task');
const { purgeAlertCountsForTicket } = require('../../maestro-cleanup');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const SKILL_NAME = process.env.SKILL_NAME || 'work';

const BOOTSTRAP_SCRIPT = path.join(__dirname, '..', '..', 'maestro-bootstrap.sh');
const REPO_NAME = process.env.REPO_NAME || 'claude-plugin-work';

/**
 * Optionally bootstrap a fresh tmux + worktree for the next ticket. Returns
 * true on launch. Gated by AUTO_BOOTSTRAP_NEXT=1 (default off — explicit
 * opt-in).
 */
function maybeAutoBootstrap(taskId) {
  if (process.env.AUTO_BOOTSTRAP_NEXT !== '1') return false;
  if (!taskId || !/^[A-Z]+-\d+$/.test(taskId)) return false;
  if (!fs.existsSync(BOOTSTRAP_SCRIPT)) return false;
  // Respect manifest-declared pool size (sum of `slots` across manifests).
  // Avoids over-bootstrapping when an operator pre-launched sessions.
  try {
    const tmuxMod = require('./tmux');
    const activeSessions = tmuxMod.listSessions ? tmuxMod.listSessions() : [];
    if (manifest.poolFullForTask(taskId, activeSessions)) return false;
  } catch {}
  const res = spawnSync('bash', [BOOTSTRAP_SCRIPT, taskId], {
    stdio: 'ignore',
    env: { ...process.env, REPO_NAME },
  });
  if (res.status === 0) {
    manifest.updateTaskStatus(taskId, 'in_progress', 'auto-bootstrapped by daemon');
    // Clear the per-lifecycle dead-end marker so the freshly-bootstrapped
    // agent gets a clean slate. Without this, freeDeadEndSlot's
    // `if (marker.killed) return false` would mute every future rotation
    // for this ticket.
    try {
      state.clear(taskId, 'dead-end');
      state.clear(taskId, 'ci-rotated');
    } catch {}
  }
  return res.status === 0;
}

// Restart-loop guard: how many auto-restarts within RESTART_WINDOW_MIN before
// we declare the session WEDGED and stop restarting. Caller is freed of state
// management — autoRestart() owns the marker.
const RESTART_LOOP_THRESHOLD = parseInt(process.env.RESTART_LOOP_THRESHOLD || '3', 10);
const RESTART_WINDOW_MIN = parseInt(process.env.RESTART_WINDOW_MIN || '30', 10);
const WEDGED_QUIET_MIN = parseInt(process.env.WEDGED_QUIET_MIN || '60', 10);

function msgFor(reason, mode) {
  const base = `MAESTRO (${mode}): ${reason}. Audit uncommitted files via git status. If any are present, dispatch the commit agent with 'autonomous' to land them, then push. Re-run task-next.js to advance the gate.`;
  if (mode === 'interrupt') {
    return `${base} I sent Esc to break any stuck subagent — do NOT re-dispatch the same one without diagnosing why it hung.`;
  }
  return base;
}

function soft(session, reason) {
  alerts.log(`${session} NUDGE soft: ${reason}`);
  tmux.sendLine(session, msgFor(reason, 'soft'));
}

function interrupt(session, reason) {
  alerts.log(`${session} NUDGE interrupt: ${reason}`);
  tmux.sendKey(session, 'Escape');
  // Brief pause so the TUI registers the Esc before we push text.
  // Use spawnSync('sleep') so we block without pinning a CPU core.
  spawnSync('sleep', ['1.5']);
  tmux.sendLine(session, msgFor(reason, 'interrupt'));
}

function alert(reasonObj) {
  return alerts.alert(reasonObj);
}

/**
 * Declare an agent wedged: record marker, log, and emit alert. Extracted from
 * autoRestart() to keep that function under the max-lines-per-function gate.
 */
function declareWedged({ session, ticket, restarts, now, silenceSec }) {
  const wedgedUntil = now + WEDGED_QUIET_MIN * 60;
  const count = restarts.length + 1;
  state.write(session, 'restart-loop', { restarts: [...restarts, now], wedgedUntil });
  alerts.log(
    `${session} WEDGED — ${count} auto-restarts in ${RESTART_WINDOW_MIN}m; suppressing restarts for ${WEDGED_QUIET_MIN}m`
  );
  const paneTail = tmux.capture(session).split('\n').slice(-50).join('\n');
  alerts.alert({
    session,
    ticket,
    kind: 'wedged',
    restartsInWindow: count,
    windowMin: RESTART_WINDOW_MIN,
    quietMin: WEDGED_QUIET_MIN,
    silenceSec,
    paneTail,
    instruction: `agent restarted ${count}x in ${RESTART_WINDOW_MIN}m. Daemon won't restart for ${WEDGED_QUIET_MIN}m. UNBLOCK-PROTOCOL: diagnose root cause from paneTail; if dead-end, kill session and bootstrap next queued.`,
  });
}

/**
 * Auto-restart a dead -work session in place: kill the existing tmux
 * session, then relaunch `claude --dangerously-skip-permissions /<skill> <ticket>`
 * inside the worktree. Returns true if the restart command was issued.
 *
 * Ported from maestro-conduct.sh's auto-restart branch. Caller is responsible
 * for restart eligibility (only -work sessions) and for clearing per-ticket
 * markers after the restart so detectors don't fire against the stale state.
 */
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
  if (!deadEnd || !deadEnd.killed) return { skip: false };
  if (!deadEnd.skipLogged) {
    alerts.log(
      `${session} AUTO-RESTART skipped: ticket ${ticket} dead-end-freed (trigger=${deadEnd.trigger || 'unknown'}); slot rotated, do not resurrect`
    );
    state.write(ticket, 'dead-end', { ...deadEnd, skipLogged: true });
  }
  return { skip: true };
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

function autoRestart({ session, ticket, worktree, silenceSec }) {
  if (checkRestartGuards({ session, ticket, worktree }).skip) return false;

  // Restart-loop guard. Read the per-session marker once and decide whether
  // we're still in the "WEDGED quiet" window from a prior loop. The marker
  // shape:
  //   { restarts: [unix_ts, ...], wedgedUntil?: unix_ts }
  // restarts[] is pruned to the last RESTART_WINDOW_MIN.
  const now = state.now();
  const marker = state.read(session, 'restart-loop') || { restarts: [] };

  if (marker.wedgedUntil && marker.wedgedUntil > now) {
    // Already declared wedged — don't restart, don't re-alert. We logged on
    // entry; further silence triggers can re-read this marker silently.
    return false;
  }

  // Prune older entries outside the rolling window.
  const cutoff = now - RESTART_WINDOW_MIN * 60;
  const restarts = (marker.restarts || []).filter((t) => t >= cutoff);

  // If we'd be at-or-over the threshold AFTER this restart, declare wedged
  // INSTEAD of restarting. The operator must intervene.
  if (restarts.length + 1 >= RESTART_LOOP_THRESHOLD) {
    declareWedged({ session, ticket, restarts, now, silenceSec });
    return false;
  }

  // Record this restart and proceed.
  state.write(session, 'restart-loop', { restarts: [...restarts, now] });

  alerts.log(
    `${session} AUTO-RESTART after ${silenceSec}s silence — relaunching /${SKILL_NAME} ${ticket}`
  );
  // Kill the dead session (no-op if already gone).
  spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
  // Relaunch in-place. argv form so the worktree path / ticket can't be
  // interpreted by a shell.
  spawnSync(
    'tmux',
    [
      'new-session',
      '-d',
      '-s',
      session,
      '-c',
      worktree,
      `${CLAUDE_BIN} --dangerously-skip-permissions '/${SKILL_NAME} ${ticket}'`,
    ],
    { stdio: 'ignore' }
  );
  return true;
}

/**
 * freeCIGateSlot — kill the -work and -listen panes of a ticket whose PR has
 * reached CI gate (CLEAN/SUCCESS, awaiting operator merge). Emits a
 * structured alert kind=slot-freed so the orchestrator can bootstrap the next
 * ticket. Idempotent: writes a per-ticket marker so repeated pr-ready emits
 * on the same SHA don't try to kill an already-killed session.
 *
 * No-op if AUTO_FREE_CI_SLOT=0.
 */
function killTicketTmux(ticket) {
  for (const suffix of ['work', 'listen']) {
    spawnSync('tmux', ['kill-session', '-t', `${ticket}-${suffix}`], { stdio: 'ignore' });
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

function freeCIGateSlot({ session, ticket, prNumber, sha }) {
  if (process.env.AUTO_FREE_CI_SLOT === '0') return false;
  const marker = state.read(session, 'slot-freed') || {};
  const ciFreed = state.read(ticket, 'ci-gate-freed') || {};
  // Kill defensively even on dup-SHA (autoRestart guard). Per-ticket marker
  // overwritten on each fresh SHA so force-push re-engages the agent.
  killTicketTmux(ticket);
  state.write(ticket, 'ci-gate-freed', { killed: true, sha, prNumber, freedAt: state.now() });
  if (marker.sha === sha || ciFreed.sha === sha) return false;
  state.write(session, 'slot-freed', { sha, prNumber, freedAt: state.now() });
  const shaShort = (sha || '').slice(0, 7);
  killAndBootstrapNext({
    session,
    ticket,
    alertKind: 'slot-freed',
    manifestStatus: 'awaiting-merge',
    manifestNote: `PR #${prNumber} CLEAN/SUCCESS at sha=${shaShort}`,
    logPrefix: `SLOT-FREED at CI gate — PR #${prNumber} sha=${shaShort} awaiting operator merge; `,
    logSuffix: ` Operator merges PR #${prNumber} separately.`,
    alertExtra: { prNumber, sha },
    purgeCounts: false,
  });
  return true;
}

/**
 * freeDeadEndSlot — agent is stuck (operator didn't respond; every menu option
 * a bypass; PR has no forward path). Triggered by re-emit escalation when the
 * same alert kind fires ≥ DEAD_END_REEMITS times.
 *
 * Attempt-based recovery: each dead-end bumps `task.attempts` in the manifest.
 * - attempts < DEAD_END_MAX_ATTEMPTS → mark `pending`, eligible for re-bootstrap
 * - attempts ≥ DEAD_END_MAX_ATTEMPTS → mark `blocked`, operator must intervene
 *
 * The per-tick `dead-end` state marker prevents duplicate kills within the
 * same tmux lifecycle but is cleared by maybeAutoBootstrap on a fresh launch
 * so the new agent gets a clean slate.
 */
const DEAD_END_MAX_ATTEMPTS = parseInt(process.env.DEAD_END_MAX_ATTEMPTS || '3', 10);

function freeDeadEndSlot({ session, ticket, kind, repeatCount, sha }) {
  if (process.env.AUTO_FREE_DEAD_END === '0') return false;
  const marker = state.read(ticket, 'dead-end') || {};
  if (marker.killed) return false; // already freed this lifecycle
  const attempts = manifest.incrementTaskAttempts(ticket);

  // First attempt: don't kill — ask the agent to diagnose itself first so the
  // operator can read what's actually blocking before rotating the slot.
  if (attempts === 1) {
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
    return true;
  }

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
  return true;
}

/**
 * maybeFillPool — when the pool has free slots (active < sum-of-slots) and
 * AUTO_BOOTSTRAP_NEXT=1, find the next eligible pending task and bootstrap.
 * Idempotent per tick: one bootstrap per call. Caller invokes once per tick
 * after syncManifest so reconciliation runs first.
 */
function maybeFillPool() {
  if (process.env.AUTO_BOOTSTRAP_NEXT !== '1') return false;
  let activeSessions = null;
  try {
    activeSessions = tmux.listSessions ? tmux.listSessions() : [];
  } catch {}
  // Guard: an empty/missing session list is ambiguous — could be a real
  // "no sessions yet" state or a transient `tmux ls` failure / prefix
  // mismatch. Bootstrapping on ambiguous signal can over-launch and exceed
  // manifest slot caps because per-task pool-cap checks also count zero.
  // Same conservatism as syncFromTmux: no signal → no action.
  if (!Array.isArray(activeSessions) || activeSessions.length === 0) {
    return false;
  }
  // Walk candidates in priority order; bootstrap the first one whose owning
  // manifest still has capacity. A full manifest must not block eligible work
  // in another manifest that still has free slots. Stop after the first
  // successful bootstrap so the tick stays idempotent.
  for (const cand of findEligibleTasks()) {
    if (activeSessions.includes(`${cand.taskId}-work`)) continue;
    const ok = maybeAutoBootstrap(cand.taskId);
    if (ok) {
      alerts.log(`POOL-FILL auto-bootstrapped ${cand.taskId} from manifest "${cand.topic}"`);
      return true;
    }
  }
  return false;
}

module.exports = {
  soft,
  interrupt,
  alert,
  autoRestart,
  freeCIGateSlot,
  freeDeadEndSlot,
  syncManifest: manifest.syncFromTmux,
  maybeFillPool,
};
