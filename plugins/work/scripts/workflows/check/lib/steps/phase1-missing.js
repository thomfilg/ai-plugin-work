'use strict';

/**
 * check/lib/steps/phase1-missing.js — how the phase-1 step talks about a
 * report that is not on disk: the description of WHY it is missing, and the
 * blocked instruction once re-dispatch is exhausted.
 *
 * Split out of phase1-agents.js so the step body stays inside the size gate;
 * the two are the only callers of each other.
 */

const path = require('node:path');

const { T, getRuntime } = require('../../../lib/instruction-vocab');

/** Lazy require, mirroring phase1-agents.js — the registry loads this module. */
function stepProgress(name) {
  return require('../step-registry').stepProgress(name);
}

/**
 * Human-readable description of why a report is missing (GH-343: distinguish
 * "agent finished but the file was never created" from "file was truncated").
 *
 * The missing case deliberately does NOT say "never created". Every
 * `*.check.md` is deleted by setupReportFolder's purge when the changes hash
 * moves, so a report the agent really did write shows up here as missing —
 * blaming the agent for the orchestrator's own delete sent readers hunting for
 * a write bug that was not there.
 */
function describeMissing(m, reportFolder) {
  const full = path.join(reportFolder, m.file);
  if (m.status === 'stale') {
    return (
      `${full} is HEAD-STALE — its failing verdict was verified at Head ${m.reportHead} but the ` +
      `worktree HEAD has since moved to ${m.currentHead} (a sibling agent committed fixes ` +
      `mid-review, GH-308); its findings may already be fixed. Re-verify against the CURRENT code`
    );
  }
  return m.status === 'empty'
    ? `${full} exists but is EMPTY (0 bytes — truncated by a write race; the agent likely finished but its report was clobbered)`
    : `${full} is missing — the agent completed without writing it, or it was written and then removed by the cycle purge when the changes hash moved`;
}

/**
 * The blocked instruction once a report has exhausted its dispatch attempts.
 *
 * The remedy used to read "Do NOT re-dispatch. … write the report yourself
 * with the Write tool". That write is refused — each report is agent-gated to
 * its owning agent (`BLOCKED: Cannot write completion.check.md — not running
 * in an authorized agent`) — so the one instruction the step gave at its dead
 * end was the one thing the reader could not do, and the step had no exit at
 * all. The owning agent is the only writer there has ever been, so the remedy
 * has to name it.
 *
 * @param {object} args
 * @param {Array} args.exhausted — missing-report records at the attempt cap
 * @param {(file: string) => string} args.ownerAgent — file → its owning agent
 * @param {string} args.reportFolder
 * @param {string} args.changesHash
 * @param {number} args.maxAttempts
 * @param {string} args.ticketId
 */
function buildExhaustedInstruction(args) {
  const { exhausted, ownerAgent, reportFolder, changesHash, maxAttempts, ticketId } = args;
  return {
    type: 'check_instruction',
    action: 'blocked',
    state: {
      ticket: ticketId,
      currentStep: '5_phase1_agents',
      progress: stepProgress('5_phase1_agents'),
    },
    reason:
      `Phase-1 agent(s) completed but their report is still missing after ` +
      `${maxAttempts} dispatch attempts:\n` +
      exhausted.map((m) => `- ${describeMissing(m, reportFolder)}`).join('\n') +
      `\nDo NOT write these reports yourself — each is agent-gated and your Write is ` +
      `blocked ("not running in an authorized agent"). Only the owning agent can ` +
      `produce one:\n` +
      exhausted.map((m) => `- ${m.file} → ${ownerAgent(m.file)}`).join('\n') +
      `\n${T('delegate.task.note.short', {}, getRuntime().name)}\n` +
      `This step will not emit another delegate — dispatch the agent yourself, telling it ` +
      `explicitly to WRITE the report file (include the Changes hash ${changesHash}) and to ` +
      `report BLOCKED rather than finish silently if it cannot. Then re-run check-next.js: ` +
      `it advances as soon as the file is there. If the same agent fails again, stop and ` +
      `surface this to the operator — do not loop.`,
  };
}

module.exports = { describeMissing, buildExhaustedInstruction };
