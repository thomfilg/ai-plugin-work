/**
 * Why /check has to run: reports that are absent, that did not pass, or —
 * echo-6842 — that are present and passing but were invalidated by a
 * loop-back. `stale` is named separately from `failed` because nothing is
 * wrong with their content; they reviewed code the workflow has moved past.
 * @param {object} s
 * @returns {string}
 */
function rerunReason(s) {
  const reasons = [
    ['missing', s?.missingReports],
    ['failed', s?.failedReports],
    ['stale', s?.staleReports],
  ]
    .filter(([, files]) => files?.length)
    .map(([label, files]) => `${label}: ${files.join(', ')}`);
  return reasons.length ? reasons.join('; ') : 'No reports found';
}

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
        `rm -f "${tasksDir}"/task[0-9]*/*.check.md`,
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
    add(STEPS.check, 'RUN', '/check', rerunReason(s), {
      agentType: 'skill',
      agentPrompt: '/check',
    });
  }
};
