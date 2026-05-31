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
const tmux = require('./tmux');
const alerts = require('./alerts');

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
  const until = Date.now() + 1500;
  while (Date.now() < until) { /* spin */ }
  tmux.sendLine(session, msgFor(reason, 'interrupt'));
}

function alert(reasonObj) {
  alerts.alert(reasonObj);
}

module.exports = { soft, interrupt, alert };
