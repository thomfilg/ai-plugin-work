/**
 * actions.js — what to do when a detector fires.
 *
 * Three actions, mapped from phase-registry.escalationFor():
 *   soft      → send a message into the agent prompt (no interrupt)
 *   interrupt → send Esc, wait, send message (used when soft nudge was ignored
 *               or when a spinner is clearly hung)
 *   alert     → no agent action; write to the maestro alert sink
 *
 * Nudge text is per-skill (skill-registry row `nudge` template) so a
 * /follow-up or /qc-work agent is never coached in /work vocabulary. Avoid
 * literal CLI strings that trip the enforce-agent-usage hook.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const tmux = require('./tmux');
const alerts = require('./alerts');
const state = require('./state');
const manifest = require('./manifest');
const progress = require('./progress');
const restartLaunch = require('./restart-launch');
const {
  findNextEligibleTask,
  findEligibleTasks,
  buildNextActionInstruction,
} = require('./next-task');
const { purgeAlertCountsForTicket } = require('../../maestro-cleanup');
const skillRegistry = require('./skill-registry');
const { formatLogLine } = require('./detectors/silence');
const {
  RESTART_LOOP_THRESHOLD,
  RESTART_WINDOW_MIN,
  declareWedged,
  checkRestartGuards,
  resolveSkillForRestart,
} = require('./restart-guards');

const BOOTSTRAP_SCRIPT = path.join(__dirname, '..', '..', 'maestro-bootstrap.sh');
const REPO_NAME = process.env.REPO_NAME || 'claude-plugin-work';

// GH-626: inherit the orchestration's command. Without --skill the bootstrap
// falls open to /work — observed live: a `command=/follow-up` pool topped up
// with `.maestro-skill = work` agents that then re-entered /work gates.
function bootstrapArgsFor(taskId) {
  const args = [BOOTSTRAP_SCRIPT];
  const command = manifest.commandForTask(taskId);
  if (command && command !== 'work') {
    args.push(`--skill=${command}`, '--allow-generic');
  }
  args.push(taskId);
  return args;
}

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
  const res = spawnSync('bash', bootstrapArgsFor(taskId), {
    stdio: 'ignore',
    env: { ...process.env, REPO_NAME },
  });
  if (res.status === 0) {
    manifest.updateTaskStatus(taskId, 'in_progress', 'auto-bootstrapped by daemon');
  }
  return res.status === 0;
}

// Resolve the nudge template from the skill's registry row so the text speaks
// the agent's own workflow vocabulary. Undefined/unknown skill → work row
// (back-compat with callers that don't thread a skill through).
function msgFor(reason, mode, skill) {
  const row = skillRegistry.get(skill) || skillRegistry.get('work');
  return row.nudge(reason, mode);
}

function soft(session, reason, skill) {
  const delivery = tmux.sendLine(session, msgFor(reason, 'soft', skill));
  alerts.log(`${session} NUDGE soft [${delivery}]: ${reason}`);
}

function interrupt(session, reason, skill) {
  tmux.sendKey(session, 'Escape');
  // Brief pause so the TUI registers the Esc before we push text.
  // Use spawnSync('sleep') so we block without pinning a CPU core.
  spawnSync('sleep', ['1.5']);
  const delivery = tmux.sendLine(session, msgFor(reason, 'interrupt', skill));
  alerts.log(`${session} NUDGE interrupt [${delivery}]: ${reason}`);
}

function alert(reasonObj) {
  return alerts.alert(reasonObj);
}

/**
 * Auto-restart a dead -work session in place: kill the existing tmux session,
 * then relaunch inside the worktree — fresh (`/<skill> <ticket>`) or resumed
 * (`--continue`) per restart-launch.restartModeFor(). Returns true if the
 * restart was issued.
 *
 * Caller is responsible for restart eligibility (only -work sessions) and for
 * clearing per-ticket markers after the restart so detectors don't fire
 * against the stale state. Eligibility guards and the wedged-loop declaration
 * live in restart-guards.js; launch mechanics in restart-launch.js.
 */
function autoRestart({ session, ticket, worktree, silenceSec }) {
  if (checkRestartGuards({ session, ticket, worktree }).skip) return false;

  // Progress guard: a "silent" pane with a worktree that changed within the
  // freshness window means the agent is producing. Skip and re-evaluate next tick.
  if (progress.hasFreshProgress(ticket)) {
    restartLaunch.logProgressSkip(session, ticket);
    return false;
  }

  // Restart-loop guard. Marker shape: { restarts: [unix_ts...], wedgedUntil? }.
  const now = state.now();
  const marker = state.read(session, 'restart-loop') || { restarts: [] };
  if (marker.wedgedUntil && marker.wedgedUntil > now) return false;

  const cutoff = now - RESTART_WINDOW_MIN * 60;
  const restarts = (marker.restarts || []).filter((t) => t >= cutoff);

  if (restarts.length + 1 >= RESTART_LOOP_THRESHOLD) {
    declareWedged({ session, ticket, restarts, now, silenceSec });
    return false;
  }

  state.write(session, 'restart-loop', { restarts: [...restarts, now] });
  const skill = resolveSkillForRestart(ticket, session); // GH-514 R1/AC2/AC6
  const mode = restartLaunch.restartModeFor(skill, worktree);
  // PR #561 follow-up: prefix the production silence log with the skill-aware
  // token from formatLogLine so operators can grep `[<ticket>:<skill>]` in
  // /tmp/maestro-conduct.log — the README's skill-adapter section promised it.
  alerts.log(
    `${formatLogLine({ ticket, skill, silenceSec, kind: 'silence' })} ${session} AUTO-RESTART after ${silenceSec}s silence — ${
      mode === 'continue' ? 'resuming conversation (--continue)' : `relaunching /${skill} ${ticket}`
    }`
  );
  const launch = restartLaunch.buildLaunchCommand(mode, skill, ticket);
  spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
  spawnSync('tmux', ['new-session', '-d', '-s', session, '-c', worktree, launch], {
    stdio: 'ignore',
  });
  restartLaunch.groomRestartedSession(session, ticket, skill);
  if (mode === 'continue') {
    tmux.sendLine(
      session,
      `MAESTRO: your session was auto-restarted after ${silenceSec}s of silence. Continue the task from where you left off; if a subprocess died with the old session, re-run it.`
    );
  }
  return true;
}

/**
 * freeCIGateSlot — kill the -work and -listen panes of a ticket whose PR has
 * reached CI gate (CLEAN/SUCCESS, awaiting operator merge). Emits a
 * structured alert kind=slot-freed so the orchestrator can bootstrap the next
 * ticket. Idempotent: a per-ticket marker keeps repeated pr-ready emits on
 * the same SHA from re-killing. No-op if AUTO_FREE_CI_SLOT=0.
 */
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

function freeCIGateSlot({ session, ticket, prNumber, sha }) {
  if (process.env.AUTO_FREE_CI_SLOT === '0') return false;
  const marker = state.read(session, 'slot-freed') || {};
  const ciFreed = state.read(ticket, 'ci-gate-freed') || {};
  // Always kill any alive tmux sessions for this ticket — defensive against
  // sessions resurrected by autoRestart between ticks. tmux kill-session is
  // idempotent and silent when the session is already gone.
  killTicketTmux(ticket);
  // Per-ticket marker that autoRestart consults to refuse resurrection.
  // Overwritten on each fresh SHA so a force-push that re-opens CI naturally
  // re-engages the agent.
  state.write(ticket, 'ci-gate-freed', { killed: true, sha, prNumber, freedAt: state.now() });
  // Skip alert + bootstrap if this exact SHA was already announced — prevents
  // spam on every tick. The kill above still runs (defensive).
  if (marker.sha === sha || ciFreed.sha === sha) return false;
  state.write(session, 'slot-freed', { sha, prNumber, freedAt: state.now() });
  manifest.updateTaskStatus(
    ticket,
    'awaiting-merge',
    `PR #${prNumber} CLEAN/SUCCESS at sha=${(sha || '').slice(0, 7)}`
  );
  const next = findNextEligibleTask();
  const autoBootstrapped = next && maybeAutoBootstrap(next.taskId);
  const prefix = `Slot freed for PR #${prNumber} (sha=${(sha || '').slice(0, 7)}). `;
  const suffix = ` Operator merges PR #${prNumber} separately.`;
  const instruction = buildNextActionInstruction({ prefix, suffix, next, autoBootstrapped });
  emitSlotFreedAlert({ session, ticket, prNumber, sha, next, autoBootstrapped, instruction });
  return true;
}

/**
 * A pending question means the agent is BLOCKED on input, not burning tokens —
 * rotating its slot is a scheduling decision. When there is no queued work to
 * rotate TO, the kill gains nothing and destroys in-flight context (observed:
 * agents killed over benign permission prompts, one while the operator was
 * mid-answer in its pane). Hold instead, quietly. Returns true when held.
 */
function holdQuestionDeadEnd({ session, ticket, kind, repeatCount }) {
  if (kind !== 'question-pending' || findNextEligibleTask()) return false;
  const hold = state.read(ticket, 'dead-end-hold') || {};
  if (!hold.loggedAt || state.minutesSince(hold.loggedAt) >= 30) {
    alerts.log(
      `${session} DEAD-END-HOLD question-pending ×${repeatCount} — no eligible next task, keeping session alive; operator must answer the prompt`
    );
    state.write(ticket, 'dead-end-hold', { loggedAt: state.now() });
  }
  return true;
}

function emitDeadEndAlert({ session, ticket, kind, repeatCount, sha, next, autoBootstrapped }) {
  const prefix = `DEAD-END on ${ticket} after ${kind} ×${repeatCount}. `;
  const instruction = buildNextActionInstruction({ prefix, suffix: '', next, autoBootstrapped });
  alerts.log(
    `${session} DEAD-END ${kind} re-fired ${repeatCount}x — tmux killed, slot freed${
      autoBootstrapped ? `; AUTO-BOOTSTRAPPED ${next.taskId}` : ''
    }`
  );
  alert({
    session,
    ticket,
    kind: 'dead-end',
    trigger: kind,
    repeatCount,
    sha,
    nextTask: next ? next.taskId : null,
    nextTopic: next ? next.topic : null,
    autoBootstrapped: !!autoBootstrapped,
    instruction,
  });
}

/**
 * freeDeadEndSlot — same kill mechanics as freeCIGateSlot but for an agent
 * stuck in a non-recoverable state (e.g. every menu option is a workflow
 * bypass; PR has no path forward without manual intervention). Triggered by
 * the re-emit escalation: when the same alert kind fires ≥ DEAD_END_REEMITS
 * times on the same session+sha+phase, the caller invokes this.
 *
 * Emits a kind=dead-end alert with a crystal-clear instruction so the
 * operator knows to bootstrap the next ticket. Idempotent per ticket.
 */
function freeDeadEndSlot({ session, ticket, kind, repeatCount, sha }) {
  if (process.env.AUTO_FREE_DEAD_END === '0') return false;
  const marker = state.read(ticket, 'dead-end') || {};
  if (marker.killed) return false; // already freed
  if (holdQuestionDeadEnd({ session, ticket, kind, repeatCount })) return false;
  killTicketTmux(ticket);
  // Purge persisted alert counts so a fresh agent on the same ticket starts
  // with a clean repeat-count slate (otherwise it could inherit a count
  // already ≥ DEAD_END_REEMITS and immediately re-trigger rotation).
  try {
    purgeAlertCountsForTicket(ticket, false);
  } catch (err) {
    alerts.log(`${session} freeDeadEndSlot: purgeAlertCountsForTicket failed: ${err.message}`);
  }
  state.write(ticket, 'dead-end', { killed: true, freedAt: state.now(), trigger: kind });
  manifest.updateTaskStatus(ticket, 'blocked', `dead-end after ${kind} ×${repeatCount}`);
  const next = findNextEligibleTask();
  const autoBootstrapped = next && maybeAutoBootstrap(next.taskId);
  emitDeadEndAlert({ session, ticket, kind, repeatCount, sha, next, autoBootstrapped });
  return true;
}

/**
 * freeStopConditionSlot — the ticket's stop-condition oracle returned exit 0,
 * so the agent has SUCCEEDED. Same kill+rotate mechanics as freeDeadEndSlot,
 * but the manifest status is `done` (not `blocked`) and the alert kind is
 * `stop-condition-met` (a positive signal). Idempotent per ticket via the
 * `stop-condition` marker. No-op when AUTO_FREE_STOP_CONDITION=0.
 */
function freeStopConditionSlot({ session, ticket, oracle }) {
  if (process.env.AUTO_FREE_STOP_CONDITION === '0') return false;
  const marker = state.read(ticket, 'stop-condition') || {};
  if (marker.killed) return false; // already freed this lifecycle
  killTicketTmux(ticket);
  try {
    purgeAlertCountsForTicket(ticket, false);
  } catch (err) {
    alerts.log(
      `${session} freeStopConditionSlot: purgeAlertCountsForTicket failed: ${err.message}`
    );
  }
  state.write(ticket, 'stop-condition', { killed: true, freedAt: state.now() });
  manifest.updateTaskStatus(ticket, 'done', 'stop-condition oracle exited 0');
  const next = findNextEligibleTask();
  const autoBootstrapped = next && maybeAutoBootstrap(next.taskId);
  const prefix = `STOP-CONDITION met on ${ticket} (oracle exit 0) — agent done. `;
  const instruction = buildNextActionInstruction({ prefix, suffix: '', next, autoBootstrapped });
  alerts.log(
    `${session} STOP-CONDITION-MET — tmux killed, slot freed${
      autoBootstrapped ? `; AUTO-BOOTSTRAPPED ${next.taskId}` : ''
    }`
  );
  alert({
    session,
    ticket,
    kind: 'stop-condition-met',
    oracle,
    nextTask: next ? next.taskId : null,
    nextTopic: next ? next.topic : null,
    autoBootstrapped: !!autoBootstrapped,
    instruction,
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
  // Guard: an empty/missing session list is ambiguous — real "no sessions
  // yet" vs transient `tmux ls` failure / prefix mismatch. Bootstrapping on
  // ambiguous signal over-launches past slot caps (which also count zero).
  // Same conservatism as syncFromTmux: no signal → no action.
  if (!Array.isArray(activeSessions) || activeSessions.length === 0) {
    return false;
  }
  // Walk candidates in priority order; bootstrap the first one whose owning
  // manifest still has capacity (a full manifest must not block another with
  // free slots). Stop after one bootstrap so the tick stays idempotent.
  for (const cand of findEligibleTasks()) {
    if (activeSessions.includes(tmux.sessionName(cand.taskId, 'work'))) continue;
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
  freeStopConditionSlot,
  syncManifest: manifest.syncFromTmux,
  maybeFillPool,
  maybeAutoBootstrap,
};
