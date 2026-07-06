/**
 * Step: 11_output — Read README.md and return display instruction.
 *
 * Severity gate (echo-5804-004): the aggregator must never mark the check
 * `complete` while a required report at the CURRENT changes hash parses as
 * NEEDS_WORK/critical. Per-report parsed statuses are recorded in state, and
 * completion SHAs (completedChangesHash / completedHeadSha) are recorded so
 * later invocations can detect staleness (GH-307).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { evaluateReports, blockingReports, recordCompletion } = require('../staleness');

// Registry-derived 'N/M' progress label. Lazy require: the registry requires
// this module at load time, so a top-level require back would see a partial
// module through the cycle (PR #669 review — stale hardcoded counts).
function stepProgress(name) {
  return require('../step-registry').stepProgress(name);
}

module.exports = function registerOutput(register) {
  register('11_output', (state, ctx) => {
    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;

    // Record per-report parsed status in state (auditable, and consumed by
    // the /work check gate's refusal logic).
    const reports = evaluateReports(reportFolder, state.changesHash);
    state.reportStatuses = reports;

    const blocking = blockingReports(reports);
    if (blocking.length > 0) {
      state.status = 'needs_work';
      return {
        type: 'check_instruction',
        action: 'needs_work',
        state: {
          ticket: state.ticketId,
          currentStep: '11_output',
          progress: stepProgress('11_output'),
        },
        reason:
          `Check finished but is NOT approved — ` +
          blocking.map((r) => `${r.file} parses as ${r.status}`).join('; ') +
          ` at the current changes hash (${state.changesHash || 'unknown'}). ` +
          `Fix the reported issues and commit; the next /check run starts a fresh cycle.`,
        reports,
      };
    }

    const readmePath = path.join(ctx.tasksDir, 'README.md');
    let readme = 'No summary generated.';
    try {
      readme = fs.readFileSync(readmePath, 'utf8');
    } catch {
      /* no README */
    }

    state.status = 'complete';
    recordCompletion(state);

    return {
      type: 'check_instruction',
      action: 'complete',
      state: {
        ticket: state.ticketId,
        currentStep: '11_output',
        progress: stepProgress('11_output'),
      },
      content: readme,
    };
  });
};
