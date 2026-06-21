/**
 * actions.js — what to do when a detector fires. Three actions, mapped from
 * phase-registry.escalationFor():
 *   soft      → send a message into the agent prompt (no interrupt)
 *   interrupt → send Esc, wait, send message (soft nudge ignored / spinner hung)
 *   alert     → no agent action; write to the maestro alert sink
 * Nudge text is intentionally generic; the agent decides how to land uncommitted
 * work (the 'commit agent' is the orchestrator's commit-writer). Avoid literal
 * CLI strings that trip the enforce-agent-usage hook.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const tmux = require('./tmux');
const namespace = require('./namespace');
const alerts = require('./alerts');
const state = require('./state');
const manifest = require('./manifest');
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
const slotRotation = require('./slot-rotation');
const { killTicketTmux } = slotRotation;
const deadEndRotation = require('./dead-end-rotation');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';

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
    // Clear per-lifecycle dead-end/ci-rotated markers AND reset the manifest
    // attempt counter so the freshly-bootstrapped agent gets a clean slate —
    // without the reset it could jump straight to `blocked` on the next stall.
    try {
      state.clear(taskId, 'dead-end');
      state.clear(taskId, 'ci-rotated');
      manifest.resetTaskAttempts(taskId);
    } catch {}
  }
  return res.status === 0;
}

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
 * Auto-restart a dead -work session in place: kill the existing tmux
 * session, then relaunch `claude --dangerously-skip-permissions /<skill> <ticket>`
 * inside the worktree. Returns true if the restart command was issued.
 *
 * Ported from maestro-conduct.sh's auto-restart branch. Caller is responsible
 * for restart eligibility (only -work sessions) and for clearing per-ticket
 * markers after the restart so detectors don't fire against the stale state.
 *
 * Eligibility guards and the wedged-loop declaration live in restart-guards.js.
 */
function autoRestart({ session, ticket, worktree, silenceSec }) {
  if (checkRestartGuards({ session, ticket, worktree }).skip) return false;

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
  // PR #561 follow-up: prefix the production silence log with the skill-aware
  // token from formatLogLine so operators can grep `[<ticket>:<skill>]` in
  // /tmp/maestro-conduct.log — the README's skill-adapter section promised it.
  alerts.log(
    `${formatLogLine({ ticket, skill, silenceSec, kind: 'silence' })} ${session} AUTO-RESTART after ${silenceSec}s silence — relaunching /${skill} ${ticket}`
  );
  spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' });
  spawnSync(
    'tmux',
    [
      'new-session',
      '-d',
      '-s',
      session,
      '-c',
      worktree,
      `${inboxEnvPrefix()}${CLAUDE_BIN} --dangerously-skip-permissions '/${skill} ${ticket}'`,
    ],
    { stdio: 'ignore' }
  );
  return true;
}

// GH-622: on an auto-restart, relaunch /work with the SAME mailbox dir
// maestro-bootstrap.sh sets on the initial launch — otherwise the restarted
// agent's messaging drifts back to the global mailbox while maestro /signal
// stays isolated. Fires when isolated (a namespace OR an explicit
// MAESTRO_INBOX_DIR override) and resolves through namespace.inboxDir() so the
// path equals maestro's own /signal side (and honors MAESTRO_INBOX_DIR). The
// value is single-quote-escaped so an override with shell metacharacters can't
// break out of the launch command.
function inboxEnvPrefix() {
  if (!namespace.ns() && !process.env.MAESTRO_INBOX_DIR) return '';
  const esc = namespace.inboxDir().replace(/'/g, "'\\''");
  return `CLAUDE_AGENT_INBOX_DIR='${esc}' `;
}

/**
 * freeCIGateSlot — kill the -work and -listen panes of a ticket whose PR has
 * reached CI gate (CLEAN/SUCCESS, awaiting operator merge). Emits a
 * structured alert kind=slot-freed so the orchestrator can bootstrap the next
 * ticket. Idempotent: writes a per-ticket marker so repeated pr-ready emits
 * on the same SHA don't try to kill an already-killed session.
 *
 * No-op if AUTO_FREE_CI_SLOT=0.
 *
 * The kill + bootstrap-next primitives (killTicketTmux, emitSlotFreedAlert,
 * killAndBootstrapNext) live in slot-rotation.js. killAndBootstrapNext is
 * called through this thin wrapper so maybeAutoBootstrap + alert (which depend
 * on actions.js internals) are injected without a circular require.
 */
function killAndBootstrapNext(args) {
  return slotRotation.killAndBootstrapNext({ ...args, maybeAutoBootstrap, alert });
}

function freeCIGateSlot({ session, ticket, prNumber, sha }) {
  if (process.env.AUTO_FREE_CI_SLOT === '0') return false;
  const marker = state.read(session, 'slot-freed') || {};
  const ciFreed = state.read(ticket, 'ci-gate-freed') || {};
  // Per-ticket marker overwritten on each fresh SHA so force-push re-engages
  // the agent. autoRestart consults it to refuse resurrection.
  state.write(ticket, 'ci-gate-freed', { killed: true, sha, prNumber, freedAt: state.now() });
  // Kill defensively even on dup-SHA (autoRestart guard); on a fresh SHA the
  // kill is performed once by killAndBootstrapNext below, so only the dup-SHA
  // early-return path needs its own kill — avoids a double kill-session.
  if (marker.sha === sha || ciFreed.sha === sha) {
    killTicketTmux(ticket);
    return false;
  }
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
 * freeCiPhaseSlot — a -work session reached `ci`/`complete`, so the agent is
 * parked (awaiting merge / already done). Kill + rotate IMMEDIATELY on the first
 * tick: no diagnostic probe, no attempt counter (that's freeDeadEndSlot's path).
 * Idempotent via the `ci-rotated` marker. Gated by AUTO_FREE_CI_SLOT.
 */
function freeCiPhaseSlot({ session, ticket, phase }) {
  if (process.env.AUTO_FREE_CI_SLOT === '0') return false;
  const marker = state.read(ticket, 'ci-rotated') || {};
  if (marker.killed) return false; // already rotated this lifecycle
  state.write(ticket, 'ci-rotated', { killed: true, freedAt: state.now() });
  // `complete` is a terminal done state; only `ci` is genuinely awaiting merge.
  const phaseLabel = phase || 'ci/complete';
  killAndBootstrapNext({
    session,
    ticket,
    alertKind: 'kill-during-ci',
    manifestStatus: phase === 'complete' ? 'done' : 'awaiting-merge',
    manifestNote: `killed at ${phaseLabel} phase — slot rotated`,
    logPrefix: `KILL-DURING-CI at ${phaseLabel} phase — agent parked, slot rotated; `,
    purgeCounts: true,
  });
  return true;
}

/**
 * freeDeadEndSlot — thin wrapper over dead-end-rotation.js. The attempt-based
 * recovery + grace-window logic lives there (extracted to keep this file under
 * the max-lines gate); killAndBootstrapNext + alert are injected here so the
 * extracted module needs no circular require back into actions.js.
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
  freeCiPhaseSlot,
  freeDeadEndSlot,
  freeStopConditionSlot,
  syncManifest: manifest.syncFromTmux,
  maybeFillPool,
};
