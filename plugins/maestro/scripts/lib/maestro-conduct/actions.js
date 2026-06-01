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
const { spawnSync } = require('child_process');
const tmux = require('./tmux');
const alerts = require('./alerts');

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const SKILL_NAME = process.env.SKILL_NAME || 'work';

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
  alerts.alert(reasonObj);
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
function autoRestart({ session, ticket, worktree, silenceSec }) {
  if (!worktree || !fs.existsSync(worktree)) {
    alerts.log(`${session} AUTO-RESTART skipped: worktree ${worktree} not found`);
    return false;
  }
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

module.exports = { soft, interrupt, alert, autoRestart };
