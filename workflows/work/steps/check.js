/**
 * Step: check
 * Runs quality checks (tests, code review, completion).
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function checkStep(add, s, ctx) {
  const { STEPS, rework, tasksDir } = ctx;

  if (rework) {
    add(STEPS.check, 'RUN', '/check', 'REWORK: Always re-run', {
      agentType: 'skill',
      agentPrompt: '/check',
      preCommands: [
        `rm -f "${tasksDir}"/*.check.md`,
        `rm -f "${tasksDir}"/.pr-update-sha`,
        `rm -f "${tasksDir}"/.post-pr-update-sha`,
      ],
    });
  } else if (s?.allReportsPass && Object.keys(s.reports).length >= 3) {
    add(
      STEPS.check,
      'DEFER',
      '/check',
      `RESUME: All ${Object.keys(s.reports).length} reports PASS`,
      {
        agentType: 'skill',
        agentPrompt: '/check',
      }
    );
  } else {
    const p = [];
    if (s?.missingReports?.length) p.push(`missing: ${s.missingReports.join(', ')}`);
    if (s?.failedReports?.length) p.push(`failed: ${s.failedReports.join(', ')}`);
    add(STEPS.check, 'RUN', '/check', p.length ? p.join('; ') : 'No reports found', {
      agentType: 'skill',
      agentPrompt: '/check',
    });
  }
};
