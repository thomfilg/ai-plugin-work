/**
 * Phase: completion_check — RETIRED, kept only to drain in-flight runs.
 *
 * This phase used to hard-block cleanup unless `completion.check.md` read
 * `**Status:** COMPLETE`. It is gone from `CLEANUP_PHASE_ORDER`: cleanup runs
 * POST-MERGE, where that evidence cannot change the outcome — it cannot
 * un-merge the PR — and could only strand a shipped ticket.
 *
 * The handler survives because deleting it outright would strand exactly the
 * runs this change exists to unblock. A ticket whose `cleanup-phase.json` was
 * written while this phase was current holds `currentPhase: "completion_check"`,
 * and the registry throws on an unknown phase — so a merged ticket mid-cleanup
 * would fail to resolve a handler and stop before branch, tmux and worktree
 * teardown. Removing a blocking gate must not itself become a blocking gate.
 *
 * So it stays reachable, always passes, and advances to the phase it used to
 * guard. Nothing routes INTO it any more (`pr_merged_check` now points straight
 * at `branch_cleanup`, and it is absent from the phase order), so only
 * previously-persisted state can land here — once, on its way past.
 */

'use strict';

const { CLEANUP_PHASES } = require('../../cleanup-phase-registry');

function validate() {
  return {
    ok: true,
    summary: 'completion_check is retired — advancing (cleanup runs post-merge)',
  };
}

function instructions(ctx) {
  return [
    '# cleanup-next — RETIRED PHASE: COMPLETION CHECK',
    `Ticket: ${ctx.ticket}`,
    '',
    'This phase no longer gates anything. Your cleanup run was saved while it',
    'still existed, so the runner is passing through it to `branch_cleanup`.',
    '',
    'Nothing to do — re-run cleanup-next.js to continue.',
    '',
  ].join('\n');
}

module.exports = function register(registerPhase) {
  registerPhase(CLEANUP_PHASES.completion_check, {
    next: CLEANUP_PHASES.branch_cleanup,
    validate,
    instructions,
  });
};

module.exports.validate = validate;
module.exports.instructions = instructions;
