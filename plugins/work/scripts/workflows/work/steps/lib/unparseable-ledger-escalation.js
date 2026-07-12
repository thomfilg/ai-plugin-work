'use strict';

/**
 * GH-696 (PR #718): operator escalation for an unparseable inner phase ledger.
 *
 * A corrupt/phase-less `<step>-phase.json` fails the ledger verifier closed
 * (phaseLedgerBlocked → currentPhase UNPARSEABLE_PHASE), but re-dispatching
 * the writer agent cannot repair it: the runner's first phase-state call
 * reads the same corrupt file and dies (`Could not init phase state` —
 * create-phase-state-cli.js readState → JSON.parse throw), so the RUN-resume
 * branch would burn dispatches into the same wall. Route to the operator
 * instead: the AskUserQuestion entry names the corrupt file and the repair
 * options, and the verifier keeps failing closed until the ledger is
 * repaired or removed (absent ledger = pre-ledger behavior, by contract).
 *
 * Reuses the escalation vocabulary of steps/task-review.js (T('tool.question')
 * + renderQuestionText) per the interactive-gates convention.
 */

const { T, renderQuestionText, getRuntime } = require('../../../lib/instruction-vocab');

/**
 * @param {Function} add - plan-matrix entry collector
 * @param {object} ctx - step context (needs `path`, `tasksDir`)
 * @param {object} opts
 * @param {string} opts.step - STEPS.* name the entry belongs to
 * @param {string} opts.ledgerFile - e.g. 'brief-phase.json'
 * @param {string} opts.artifact - e.g. 'brief.md'
 */
function addUnparseableLedgerEscalation(add, ctx, { step, ledgerFile, artifact }) {
  const rt = getRuntime();
  const ledgerPath = ctx.path.join(ctx.tasksDir, ledgerFile);
  add(
    step,
    'RUN',
    T('tool.question', {}, rt.name),
    `${ledgerFile} is unparseable — operator repair needed (re-dispatching the writer cannot fix a corrupt ledger)`,
    {
      agentType: 'general-purpose',
      agentPrompt: renderQuestionText(
        `The inner phase ledger ${ledgerPath} is corrupt or has no valid currentPhase, so the ${artifact} verifier fails closed — and re-dispatching the writer agent cannot repair it (its runner reads the same corrupt file and exits with "Could not init phase state"). Use AskUserQuestion to ask the user how to repair: (a) delete ${ledgerPath} so the workflow treats ${artifact} as authored without a phase ledger (pre-ledger behavior), (b) restore valid JSON in the ledger (e.g. from a backup, with a known-good currentPhase) so the runner resumes from it, or (c) abort. Do NOT modify or delete the ledger yourself before the user answers.`,
        rt
      ),
    }
  );
}

module.exports = { addUnparseableLedgerEscalation };
