/**
 * Step: brief
 * Generates the product brief from ticket requirements.
 *
 * Decision matrix:
 *   1. hasBrief=true, ledger terminal/absent → DEFER (artifact already present)
 *   2. hasBrief=true, ledger mid-flight      → RUN  (GH-696: re-dispatch the
 *      brief-writer — brief-next.js resumes from the recorded phase; the
 *      ledger-blocked verifier would otherwise wedge on a bare DEFER)
 *   3. hasBrief=false                        → RUN  (generate the brief)
 *
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function briefStep(add, s, ctx) {
  const { STEPS, t, tasksDir, getDocsPrompt, fileExists, path } = ctx;

  if (s?.hasBrief && !s.briefPhaseMidFlight) {
    add(STEPS.brief, 'DEFER', null, 'brief.md already exists');
  } else if (s?.hasBrief && s.briefPhaseMidFlight) {
    add(
      STEPS.brief,
      'RUN',
      'Task(brief-writer)',
      `brief.md exists but brief-phase.json is mid-flight at "${s.briefPhase}" — resume the brief runner`,
      {
        agentType: 'brief-writer',
        agentPrompt: `Resume the product brief for ticket ${t}: brief.md exists at ${path.join(tasksDir, 'brief.md')} but the inner phase ledger brief-phase.json is at "${s.briefPhase}" (not "done").\n\n**Run \`node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-brief/brief-next.js ${t}\` and follow its instructions** — it resumes from the recorded phase and tells you what each remaining phase needs until the ledger reaches "done". Do NOT edit brief-phase.json directly.${getDocsPrompt('READ_DOCS_ON_BRIEF')}`,
      }
    );
  } else {
    add(
      STEPS.brief,
      'RUN',
      'Task(brief-writer)',
      'Generate product brief from ticket requirements',
      {
        agentType: 'brief-writer',
        agentPrompt: `Generate a product brief for ticket ${t} based on the ticket requirements fetched in the previous step.\n\nSave the brief to: ${path.join(tasksDir, 'brief.md')}\n\nStructure it with: Problem Statement, Goal, Target Users, Requirements (P0/P1/P2), Constraints, Out of Scope, Success Metrics, Open Questions.${getDocsPrompt('READ_DOCS_ON_BRIEF')}`,
      }
    );
  }
};
