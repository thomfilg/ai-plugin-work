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
const { eligibleTasks } = require('./session-shared');
const { purgeAlertCountsForTicket } = require('../../maestro-cleanup');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const SKILL_NAME = process.env.SKILL_NAME || 'work';

const SESSION_MANIFEST_DIR =
  process.env.MAESTRO_SESSION_DIR ||
  path.join(process.env.HOME || '/tmp', '.cache', 'maestro', 'sessions');
const BOOTSTRAP_SCRIPT = path.join(__dirname, '..', '..', 'maestro-bootstrap.sh');
const REPO_NAME = process.env.REPO_NAME || 'claude-plugin-work';

/**
 * Look across every orchestration manifest in ~/.cache/maestro/sessions/ for
 * the next pending task whose deps are all done. Returns { topic, taskId } or
 * null. First match wins (lowest priority across all manifests).
 */
function readManifestSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function topPendingForManifest(manifest, entry) {
  // Reuse session-shared.eligibleTasks so the slot-freed bootstrap path and
  // the maestro-session CLI agree on the next task (incl. default priority).
  const ranked = eligibleTasks(Array.isArray(manifest.tasks) ? manifest.tasks : []);
  if (ranked.length === 0) return null;
  const top = ranked[0];
  return {
    topic: manifest.topic || entry.replace(/\.json$/, ''),
    taskId: top.id,
    priority: top.priority,
  };
}

function findNextEligibleTask() {
  if (!fs.existsSync(SESSION_MANIFEST_DIR)) return null;
  let best = null;
  // Sort manifest filenames so readdirSync iteration order is deterministic
  // across filesystems. This gives a stable tie-break by filename when two
  // eligible tasks share the same numeric priority (the natural tie-break
  // here is ticket id, since manifest filenames are derived from topic/ticket).
  const entries = fs.readdirSync(SESSION_MANIFEST_DIR).slice().sort();
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const manifest = readManifestSafe(path.join(SESSION_MANIFEST_DIR, entry));
    if (!manifest) continue;
    const candidate = topPendingForManifest(manifest, entry);
    if (!candidate) continue;
    if (!best || (candidate.priority || 999) < (best.priority || 999)) {
      best = candidate;
    }
  }
  return best;
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
  const res = spawnSync('bash', [BOOTSTRAP_SCRIPT, taskId], {
    stdio: 'ignore',
    env: { ...process.env, REPO_NAME },
  });
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
  alerts.alert({
    session,
    ticket,
    kind: 'wedged',
    restartsInWindow: count,
    windowMin: RESTART_WINDOW_MIN,
    quietMin: WEDGED_QUIET_MIN,
    silenceSec,
    instruction: `tmux capture-pane -t ${session} -p | tail -50 — agent restarted ${count}x in ${RESTART_WINDOW_MIN}m. Daemon won't restart for ${WEDGED_QUIET_MIN}m. Diagnose root cause; if dead-end, kill session and bootstrap next bug.`,
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
  alerts.log(
    `${session} AUTO-RESTART skipped: ticket ${ticket} CI-gate-freed at sha=${(ciFreed.sha || '').slice(0, 7)}; awaiting operator merge`
  );
  return { skip: true };
}

function checkDeadEndGuard({ session, ticket }) {
  const deadEnd = state.read(ticket, 'dead-end');
  if (!deadEnd || !deadEnd.killed) return { skip: false };
  alerts.log(
    `${session} AUTO-RESTART skipped: ticket ${ticket} dead-end-freed (trigger=${deadEnd.trigger || 'unknown'}); slot rotated, do not resurrect`
  );
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
function buildNextActionInstruction({ prefix, suffix, next, autoBootstrapped }) {
  if (autoBootstrapped) {
    return `${prefix}NEXT_ACTION=auto-bootstrapped ${next.taskId} from manifest "${next.topic}". No operator action needed unless bootstrap log shows failure.`;
  }
  if (next) {
    return `${prefix}NEXT_ACTION=bootstrap ${next.taskId} (manifest "${next.topic}", priority=${next.priority}). Run: bash plugins/maestro/scripts/maestro-bootstrap.sh ${next.taskId}. Set AUTO_BOOTSTRAP_NEXT=1 to skip this step.${suffix}`;
  }
  return `${prefix}NEXT_ACTION=do-nothing — no eligible pending task across orchestration manifests.${suffix}`;
}

function killTicketTmux(ticket) {
  for (const suffix of ['work', 'listen']) {
    spawnSync('tmux', ['kill-session', '-t', `${ticket}-${suffix}`], { stdio: 'ignore' });
  }
}

function emitSlotFreedAlert({ session, ticket, prNumber, sha, next, autoBootstrapped, instruction }) {
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
  const next = findNextEligibleTask();
  const autoBootstrapped = next && maybeAutoBootstrap(next.taskId);
  const prefix = `Slot freed for PR #${prNumber} (sha=${(sha || '').slice(0, 7)}). `;
  const suffix = ` Operator merges PR #${prNumber} separately.`;
  const instruction = buildNextActionInstruction({ prefix, suffix, next, autoBootstrapped });
  emitSlotFreedAlert({ session, ticket, prNumber, sha, next, autoBootstrapped, instruction });
  return true;
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
  const next = findNextEligibleTask();
  const autoBootstrapped = next && maybeAutoBootstrap(next.taskId);
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
  return true;
}

module.exports = { soft, interrupt, alert, autoRestart, freeCIGateSlot, freeDeadEndSlot };
