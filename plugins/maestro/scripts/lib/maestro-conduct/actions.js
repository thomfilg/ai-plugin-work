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
 *
 * Slot-freeing paths (CI-phase rotation, dead-end rotation, stop-condition
 * reap) all flow through slot-rotation.killAndBootstrapNext; the dead-end
 * probe/strike tiers live in dead-end-rotation.js (PR #603).
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
const runtimeProfile = require('./runtime-profile');
const slotRotation = require('./slot-rotation');
const deadEndRotation = require('./dead-end-rotation');
const {
  findNextEligibleTask,
  findEligibleTasks,
  buildNextActionInstruction,
} = require('./next-task');
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
  // Respect manifest-declared pool size (global live -work count vs the
  // owning manifest's slots). Avoids over-bootstrapping when an operator
  // pre-launched sessions or a sibling manifest already fills the machine.
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

function soft(session, reason, skill, dialect) {
  const delivery = tmux.sendLine(session, msgFor(reason, 'soft', skill), dialect);
  alerts.log(`${session} NUDGE soft [${delivery}]: ${reason}`, { kind: 'log-only' });
}

function interrupt(session, reason, skill, dialect) {
  tmux.sendKey(session, 'Escape');
  // Brief pause so the TUI registers the Esc before we push text.
  // Use spawnSync('sleep') so we block without pinning a CPU core.
  spawnSync('sleep', ['1.5']);
  const delivery = tmux.sendLine(session, msgFor(reason, 'interrupt', skill), dialect);
  alerts.log(`${session} NUDGE interrupt [${delivery}]: ${reason}`, { kind: 'log-only' });
}

function alert(reasonObj) {
  return alerts.alert(reasonObj);
}

/** killAndBootstrapNext with this module's maybeAutoBootstrap + alert bound. */
function killAndBootstrapNext(args) {
  return slotRotation.killAndBootstrapNext({ ...args, maybeAutoBootstrap, alert });
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
// Per-ticket runtime (WP-09): callers that already resolved it (ctxFor) pass
// it through; direct callers fall back to the profile chain. 'claude'
// resolves for every pre-WP-09 fleet, keeping those paths byte-identical.
function resolveRestartRuntime(ticket, runtime) {
  return runtime || runtimeProfile.runtimeForTicket(ticket);
}

// The post-restart continuation notice is typed into the composer — a claude
// surface. Codex resume panes have no composer; the resume prompt itself is
// the (unverified, WP-12) answer channel, so the typed notice is skipped.
function maybeSendContinueNotice({ session, mode, runtime, silenceSec }) {
  if (mode !== 'continue' || runtime === 'codex') return;
  tmux.sendLine(
    session,
    `MAESTRO: your session was auto-restarted after ${silenceSec}s of silence. Continue the task from where you left off; if a subprocess died with the old session, re-run it.`
  );
}

function autoRestart({ session, ticket, worktree, silenceSec, runtime }) {
  if (checkRestartGuards({ session, ticket, worktree }).skip) return false;
  const rt = resolveRestartRuntime(ticket, runtime);

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
  const mode = restartLaunch.restartModeFor(skill, worktree, rt);
  // PR #561 follow-up: prefix the production silence log with the skill-aware
  // token from formatLogLine so operators can grep `[<ticket>:<skill>]` in
  // /tmp/maestro-conduct.log — the README's skill-adapter section promised it.
  alerts.log(
    `${formatLogLine({ ticket, skill, silenceSec, kind: 'silence' })} ${session} AUTO-RESTART after ${silenceSec}s silence — ${
      mode === 'continue' ? 'resuming conversation (--continue)' : `relaunching /${skill} ${ticket}`
    }`,
    { kind: 'log-only' } // self-heal announcement — the daemon already acted
  );
  const launch = restartLaunch.buildLaunchCommand(mode, skill, ticket, rt);
  spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
  spawnSync('tmux', ['new-session', '-d', '-s', session, '-c', worktree, launch], {
    stdio: 'ignore',
  });
  restartLaunch.groomRestartedSession(session, ticket, skill, rt);
  maybeSendContinueNotice({ session, mode, runtime: rt, silenceSec });
  return true;
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
    }`,
    { kind: 'log-only' } // the paired kind=slot-freed alert() carries the payload
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
 * freeCIGateSlot — kill the -work and -listen panes of a ticket whose PR has
 * reached CI gate (CLEAN/SUCCESS, awaiting operator merge). Emits a
 * structured alert kind=slot-freed so the orchestrator can bootstrap the next
 * ticket. Idempotent: a per-ticket marker keeps repeated pr-ready emits on
 * the same SHA from re-killing. No-op if AUTO_FREE_CI_SLOT=0.
 */
function freeCIGateSlot({ session, ticket, prNumber, sha }) {
  if (process.env.AUTO_FREE_CI_SLOT === '0') return false;
  const marker = state.read(session, 'slot-freed') || {};
  const ciFreed = state.read(ticket, 'ci-gate-freed') || {};
  // Always kill any alive tmux sessions for this ticket — defensive against
  // sessions resurrected by autoRestart between ticks; kill is idempotent.
  slotRotation.killTicketTmux(ticket);
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
  const next = findNextEligibleTask(ticket);
  const autoBootstrapped = next && maybeAutoBootstrap(next.taskId);
  const prefix = `Slot freed for PR #${prNumber} (sha=${(sha || '').slice(0, 7)}). `;
  const suffix = ` Operator merges PR #${prNumber} separately.`;
  const instruction = buildNextActionInstruction({ prefix, suffix, next, autoBootstrapped });
  emitSlotFreedAlert({ session, ticket, prNumber, sha, next, autoBootstrapped, instruction });
  return true;
}

/**
 * freeCiPhaseSlot — /work phase reached ci/complete: the agent is parked
 * (waiting on CI or operator merge, or fully done) and holds a pool slot for
 * nothing. Kill immediately + rotate (PR #603 operator decision — no probe,
 * no attempt counter). Manifest status: `done` at complete, `awaiting-merge`
 * at ci. Idempotent per ticket via the `ci-rotated` marker; the
 * `ci-gate-freed` marker stops autoRestart from resurrecting the session.
 * Gated by AUTO_FREE_CI_SLOT (independent of AUTO_FREE_DEAD_END).
 */
function freeCiPhaseSlot({ session, ticket, phase }) {
  if (process.env.AUTO_FREE_CI_SLOT === '0') return false;
  const marker = state.read(ticket, 'ci-rotated') || {};
  if (marker.killed) return false; // already rotated this lifecycle
  state.write(ticket, 'ci-rotated', { killed: true, phase, freedAt: state.now() });
  state.write(ticket, 'ci-gate-freed', { killed: true, sha: null, freedAt: state.now() });
  const done = phase === 'complete';
  killAndBootstrapNext({
    session,
    ticket,
    alertKind: 'kill-during-ci',
    manifestStatus: done ? 'done' : 'awaiting-merge',
    manifestNote: done
      ? 'workflow complete; slot rotated'
      : `parked at phase=${phase}; slot rotated, operator merges separately`,
    logPrefix: `CI-PHASE rotation (phase=${phase}) — `,
    alertExtra: { phase },
    purgeCounts: true,
  });
  return true;
}

/**
 * freeDeadEndSlot — attempt-based dead-end recovery (probe → kill+requeue →
 * blocked). Tiers, grace windows, and the question/progress holds live in
 * dead-end-rotation.js; this wrapper injects the bound rotation primitives.
 */
function freeDeadEndSlot({ session, ticket, kind, repeatCount, sha }) {
  return deadEndRotation.freeDeadEndSlot({
    session,
    ticket,
    kind,
    repeatCount,
    sha,
    killAndBootstrapNext,
    alert,
  });
}

/**
 * freeStopConditionSlot — the ticket's stop-condition oracle returned exit 0,
 * so the agent has SUCCEEDED. Kill + rotate; manifest status `done`; alert
 * kind `stop-condition-met` (a positive signal). Idempotent per ticket via
 * the `stop-condition` marker. No-op when AUTO_FREE_STOP_CONDITION=0.
 */
function freeStopConditionSlot({ session, ticket, oracle }) {
  if (process.env.AUTO_FREE_STOP_CONDITION === '0') return false;
  const marker = state.read(ticket, 'stop-condition') || {};
  if (marker.killed) return false; // already freed this lifecycle
  state.write(ticket, 'stop-condition', { killed: true, freedAt: state.now() });
  killAndBootstrapNext({
    session,
    ticket,
    alertKind: 'stop-condition-met',
    manifestStatus: 'done',
    manifestNote: 'stop-condition oracle exited 0',
    logPrefix: 'STOP-CONDITION-MET — ',
    alertExtra: { oracle },
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
      alerts.log(`POOL-FILL auto-bootstrapped ${cand.taskId} from manifest "${cand.topic}"`, {
        kind: 'log-only',
      });
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
  freeCiPhaseSlot,
  freeDeadEndSlot,
  freeStopConditionSlot,
  syncManifest: manifest.syncFromTmux,
  maybeFillPool,
  maybeAutoBootstrap,
};
