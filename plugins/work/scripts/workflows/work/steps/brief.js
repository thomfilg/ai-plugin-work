/**
 * Step: brief
 * Generates the product brief from ticket requirements.
 *
 * Decision matrix:
 *   1. hasBrief=true  → DEFER (artifact already present)
 *   2. hasBrief=false → RUN  (generate the brief)
 *
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function briefStep(add, s, ctx) {
  const { STEPS, t, tasksDir, getDocsPrompt, fileExists, path } = ctx;

  if (s?.hasBrief) {
    add(STEPS.brief, 'DEFER', null, 'brief.md already exists');
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
