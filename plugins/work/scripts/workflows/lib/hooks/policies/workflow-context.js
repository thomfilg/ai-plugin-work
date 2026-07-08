/**
 * policies/workflow-context.js
 *
 * Ticket/state context readers for enforce-step-workflow.js:
 *
 *   - resolveTicketId(): active-ticket detection (env override > command >
 *     .git/HEAD > transcript_path) with GH-146 phase-suffix composition
 *   - createStateLoader(): JSON state-file reader with the GH-452 visibility
 *     retry and the legacy .workflow-state.json fallback
 *   - getCurrentStep(): single in_progress step with dual-active warning
 */

const fs = require('fs');
const path = require('path');

// (Patch 11) Transient stderr logging gated behind debug env var
const DEBUG = !!process.env.ENFORCE_HOOK_DEBUG;

// Broad ticket pattern — no hardcoded project prefix.
const TICKET_IN_TEXT = /\b[A-Z]+-\d+\b/;
const TICKET_IN_REF = /[A-Z]+-\d+/;

// Compose with suffix when present (GH-146: phase-aware state paths)
// Only append if ticketId doesn't already contain a '/' (prevent double-suffixing)
function applyPhaseSuffix(ticketId) {
  if (
    ticketId &&
    !ticketId.includes('/') &&
    process.env.ENFORCE_HOOK_SUFFIX &&
    /^[a-zA-Z0-9_-]+$/.test(process.env.ENFORCE_HOOK_SUFFIX)
  ) {
    return ticketId + '/' + process.env.ENFORCE_HOOK_SUFFIX;
  }
  return ticketId;
}

// The Bash command itself (when present) is the most explicit signal —
// a developer running `node task-next.js ECHO-XXXX taskN` literally
// states which ticket they're working on.
function ticketFromCommand(hookData) {
  const cmd = hookData?.tool_input?.command;
  if (typeof cmd !== 'string') return null;
  const m = cmd.match(TICKET_IN_TEXT);
  return m ? m[0] : null;
}

// .git/HEAD is *usually* right but breaks in symlinked-worktree setups where
// the worktree directory name doesn't match the checked-out branch (e.g.
// tabwoah-ECHO-4628/ with branch ECHO-4465 checked out — observed in real
// incidents). (Patch 6+9) Worktree-aware read — no subprocess spawn.
// The caller injects readGitHeadRef (worktree resolve + plain-repo fallback).
function ticketFromGitHead(readGitHeadRef) {
  try {
    const ref = readGitHeadRef();
    const match = ref.match(TICKET_IN_REF);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

// transcript_path is the weakest signal but a useful last resort when
// neither command nor cwd identify a ticket.
function ticketFromTranscript(hookData) {
  if (!hookData || typeof hookData?.transcript_path !== 'string') return null;
  const m = hookData.transcript_path.match(TICKET_IN_TEXT);
  return m ? m[0] : null;
}

/**
 * Resolve the active ticket ID. Priority order: env override > command >
 * .git/HEAD > transcript_path. Returns null when nothing identifies a ticket.
 *
 * ENFORCE_HOOK_TICKET_ID allows override for testing — empty string
 * explicitly opts out (no git fallback).
 */
function resolveTicketId(hookData, readGitHeadRef) {
  if ('ENFORCE_HOOK_TICKET_ID' in process.env) {
    return applyPhaseSuffix(process.env.ENFORCE_HOOK_TICKET_ID || null);
  }
  let ticketId = hookData ? ticketFromCommand(hookData) : null;
  if (!ticketId) ticketId = ticketFromGitHead(readGitHeadRef);
  if (!ticketId) ticketId = ticketFromTranscript(hookData);
  return applyPhaseSuffix(ticketId);
}

/**
 * Create a loadStateFile(ticketId, stateFile) reader bound to the tasks base.
 *
 * GH-452: on slow GitHub Actions runners, a parent's fs.writeFileSync can
 * return before the just-spawned child's readFileSync sees the file. Retry
 * once with a short busy-wait to cover that visibility window.
 */
function createStateLoader({ tasksBase, safeTicketPath }) {
  return function loadStateFile(ticketId, stateFile) {
    const p = path.join(tasksBase, safeTicketPath(ticketId), stateFile);
    const readOnce = () => {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf-8'));
      } catch (err) {
        if (err && err.code === 'ENOENT') return undefined;
        return null;
      }
    };
    let parsed = readOnce();
    if (parsed === undefined) {
      const sab = new SharedArrayBuffer(4);
      Atomics.wait(new Int32Array(sab), 0, 0, 50);
      parsed = readOnce();
    }
    if (parsed !== undefined && parsed !== null) return parsed;
    // Legacy fallback: per-workflow files (e.g. .work-pr.workflow-state.json)
    // may not exist if the state was written before per-workflow split.
    // Try the legacy .workflow-state.json and check the workflow field matches.
    if (stateFile !== '.workflow-state.json' && stateFile.endsWith('.workflow-state.json')) {
      const legacyPath = path.join(tasksBase, safeTicketPath(ticketId), '.workflow-state.json');
      try {
        const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
        // Derive expected workflow name from stateFile: .work-pr.workflow-state.json -> work-pr
        const expectedWorkflow = stateFile
          .replace(/^\./, '')
          .replace(/\.workflow-state\.json$/, '');
        if (legacy?.workflow === expectedWorkflow) return legacy;
      } catch {} /* no legacy file either */
    }
    return null;
  };
}

// Dual in_progress detection — warn but still fail-open
function getCurrentStep(state, steps) {
  if (!state?.stepStatus) return null;
  const active = steps.filter((s) => state.stepStatus[s] === 'in_progress');
  if (active.length > 1) {
    if (DEBUG)
      process.stderr.write(
        `WARNING: Multiple steps in_progress: ${active.join(', ')}. Using first.\n`
      );
  }
  return active[0] || null;
}

module.exports = {
  resolveTicketId, // env > command > .git/HEAD > transcript_path
  createStateLoader, // JSON state reader with GH-452 retry + legacy fallback
  getCurrentStep, // single in_progress step (dual-active warns)
};
