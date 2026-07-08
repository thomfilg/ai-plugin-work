'use strict';

/**
 * session-guard/hook-handlers.js — PreCompact + Stop hook handlers.
 *
 * PreCompact — Output workflow reminder to stdout
 * Stop       — Block stop if unrevealed session exists
 */

const path = require('path');

// Canonical git-worktree-root resolver — shared, do not reimplement.
const { resolveWorktreeRoot } = require(path.join(__dirname, '..', '..', 'ticket-validation'));
const {
  currentSessionId,
  getTicketId,
  isCheckWorkflowActive,
  isOtherOwner,
  readTicketArtifact,
  readWorkState,
} = require(path.join(__dirname, 'context'));
const { findActiveSessions } = require(path.join(__dirname, 'store'));

/**
 * Active sessions owned by THIS terminal/worktree. Sessions owned by a
 * different terminal or worktree are dropped (lock bleed): without this, a
 * lock created by a workflow in worktree A (or a finished session whose
 * worktree was removed, leaving its shell in another workflow's cwd) gets
 * force-held by THAT workflow's lock and fed its delegate instructions.
 * Scoping by Claude session id + git worktree root prevents the bleed.
 */
function ownedActiveSessions(hookData) {
  const csid = currentSessionId(hookData);
  const currentRoot = resolveWorktreeRoot();
  return findActiveSessions().filter((s) => !isOtherOwner(s, csid, currentRoot));
}

function handlePreCompact(hookData) {
  const sessions = ownedActiveSessions(hookData);
  if (sessions.length === 0) {
    process.exit(0);
    return;
  }

  // Only show reminders for sessions belonging to the current ticket context
  const currentTicket = getTicketId();
  const relevant = currentTicket ? sessions.filter((s) => s.ticketId === currentTicket) : sessions;
  if (relevant.length === 0) {
    process.exit(0);
    return;
  }

  const lines = [];
  for (const session of relevant) {
    lines.push(
      `ACTIVE WORKFLOW SESSION - DO NOT ABANDON`,
      `Workflow: ${session.workflow} | Ticket: ${session.ticketId}`,
      `You MUST continue this workflow. Run: ${session.workflow} ${session.ticketId}`,
      `The session is locked with a passphrase. Complete all steps to unlock.`,
      ''
    );
  }

  process.stdout.write(lines.join('\n'));
  process.exit(0);
}

/**
 * For /work sessions, try to provide an actionable message with current step
 * info. Returns false when no work state is readable (caller falls through to
 * the generic block message).
 */
function blockWithWorkStepInfo(session) {
  if (session.workflow !== '/work') return false;
  const workState = readWorkState(session.ticketId);
  if (!workState) return false;
  process.stderr.write(
    `BLOCKED: You are mid-workflow (/work ${workState.ticketId}). DO NOT STOP.\n\n` +
      `Current step: ${workState.stepName}\n` +
      `Your next action: Run the orchestrator to get your plan and continue executing ALL remaining steps:\n` +
      '  node "${CLAUDE_PLUGIN_ROOT}/scripts/workflows/work/engine/work.workflow.js" ' +
      workState.ticketId +
      '\n\n' +
      "Then execute each RUN step in order. Do NOT stop until the workflow reaches 'complete'.\n" +
      'The only step that allows user interaction is brief_gate.\n'
  );
  process.exit(2);
  return true;
}

/** Block a /follow-up stop — unless its state file says the run is complete. */
function blockFollowUpStop(workflow, ticketId) {
  // Check follow-up state — if completed, allow stop.
  try {
    const fuRaw = readTicketArtifact(ticketId, '.follow-up-state.json');
    if (fuRaw) {
      const fu = JSON.parse(fuRaw);
      if (fu && fu.status === 'complete') {
        process.exit(0);
        return;
      }
    }
  } catch {
    /* unreadable — fall through to block */
  }

  // Surface the most recently computed follow-up instruction (written by
  // follow-up-auto-advance.js after each tool call) so the agent has the
  // next step inline — not just "go run follow-up-next.js again".
  const pendingInstruction = readTicketArtifact(ticketId, '.follow-up-next.json') || '';

  process.stderr.write(
    `ACTIVE WORKFLOW SESSION — DO NOT ABANDON\n` +
      `Workflow: ${workflow} | Ticket: ${ticketId}\n` +
      `You MUST continue this workflow. Run:\n` +
      `  node "\${CLAUDE_PLUGIN_ROOT}/scripts/workflows/follow-up/follow-up-next.js" ${ticketId}\n` +
      `Execute the returned instruction, then re-run follow-up-next.js until action: "complete".\n` +
      (pendingInstruction
        ? `\n=== PENDING /follow-up INSTRUCTION ===\n${pendingInstruction}\n=== END INSTRUCTION ===\n\n`
        : '') +
      `The session is locked with a passphrase. Complete all steps to unlock.\n`
  );
  process.exit(2);
}

/**
 * Check if the workflow step is dispatched (agent is waiting for sub-agent
 * results). Lock-by-default: the agent may only stop at the three user-review
 * checkpoints (brief, spec, and tasks generation):
 *   - brief_gate: user must approve the brief before spec
 *   - spec_gate: user must approve the spec before tasks split
 *   - tasks: user reviews tasks.md before implement begins
 * Every other dispatched step (implement, commit, task_review, check, pr,
 * ready, follow_up, ci, cleanup, reports) MUST continue.
 */
function allowUserReviewCheckpointStop(ticketId) {
  try {
    const ws = JSON.parse(readTicketArtifact(ticketId, '.work-state.json'));
    const allowStopSteps = new Set(['brief_gate', 'spec_gate', 'tasks']);
    if (ws && allowStopSteps.has(ws._work2Dispatched)) {
      process.stderr.write(
        `Pausing at user-review checkpoint "${ws._work2Dispatched}".\n` +
          `When ready, continue: node "\${CLAUDE_PLUGIN_ROOT}/scripts/workflows/work/work-next.js" ${ticketId}\n`
      );
      process.exit(0); // allow stop — this is a human-approval gate
      return true;
    }
  } catch {
    // Can't read state — fall through to block
  }
  return false;
}

/** Write the block message for the first held session and exit 2. */
function blockStop(session) {
  if (blockWithWorkStepInfo(session)) return;

  const workflow = session.workflow || '/work';
  const ticketId = session.ticketId || '';

  if (workflow === '/follow-up') {
    blockFollowUpStop(workflow, ticketId);
    return;
  }

  if (workflow === '/work') {
    if (allowUserReviewCheckpointStop(ticketId)) return;
    process.stderr.write(
      `ACTIVE WORKFLOW SESSION — DO NOT ABANDON\n` +
        `Workflow: ${workflow} | Ticket: ${ticketId}\n` +
        `You MUST continue this workflow. Run:\n` +
        `  node "\${CLAUDE_PLUGIN_ROOT}/scripts/workflows/work/work-next.js" ${ticketId}\n` +
        `Execute the returned instruction, then re-run work-next.js until action: "complete".\n` +
        `The session is locked with a passphrase. Complete all steps to unlock.\n`
    );
  } else {
    process.stderr.write(
      `ACTIVE WORKFLOW SESSION — DO NOT ABANDON\n` +
        `Workflow: ${workflow} | Ticket: ${ticketId}\n` +
        `You MUST continue this workflow. Run: ${workflow} ${ticketId}\n` +
        `The session is locked with a passphrase. Complete all steps to unlock.\n`
    );
  }
  process.exit(2);
}

function handleStop(hookData) {
  const sessions = ownedActiveSessions(hookData);
  if (sessions.length === 0) {
    process.exit(0);
    return;
  }

  // Check for abort keyword in stop message
  const stopMessage = hookData?.stop_message || '';
  if (/abort\s+workflow/i.test(stopMessage)) {
    process.exit(0);
    return;
  }

  // Only consider sessions owned by this ticket context (or cwd as fallback)
  const currentTicket = getTicketId();
  const currentCwd = process.cwd();
  const ownedSessions = currentTicket
    ? sessions.filter((s) => s.ticketId === currentTicket)
    : sessions.filter((s) => !s.cwd || s.cwd === currentCwd); // fallback to cwd filter

  // Check if any owned session is unrevealed (tests: cwd match, no-match, legacy without cwd)
  const unrevealed = ownedSessions.filter((s) => !s.revealed);
  if (unrevealed.length === 0) {
    process.exit(0);
    return;
  }

  // Allow stop only if ALL unrevealed sessions have /check active
  const nonCheckSessions = unrevealed.filter((s) => !isCheckWorkflowActive(s.ticketId));
  if (nonCheckSessions.length === 0) {
    process.exit(0); // All sessions are under /check — allow stop
    return;
  }

  blockStop(nonCheckSessions[0]);
}

module.exports = { handlePreCompact, handleStop };
