const { runStartupValidation } = require('../../lib/config-validate');

/**
 * Step: bootstrap
 * Creates worktree and/or ensures PR exists.
 * @param {Function} add
 * @param {object} s
 * @param {object} ctx
 */
module.exports = function bootstrapStep(add, s, ctx) {
  // R11: run config validation once at the startup seam, strictly fail-open —
  // a typo'd config key surfaces a non-blocking warning on the same /work run
  // and the step continues unchanged. runStartupValidation is itself guarded
  // (once-per-invocation marker) and never throws, but wrap defensively so
  // bootstrap behavior is byte-for-byte unchanged regardless.
  try {
    runStartupValidation();
  } catch {
    // Fail-open: never let startup validation disturb the bootstrap step.
  }

  const { STEPS, ticket, t } = ctx;

  if (s?.worktreeExists && s?.pr) {
    add(STEPS.bootstrap, 'DEFER', null, `Worktree + PR #${s.pr.number} exist`);
  } else if (s?.worktreeExists) {
    add(STEPS.bootstrap, 'RUN', `/bootstrap ${ticket}`, 'Worktree exists but no PR', {
      agentType: 'skill',
      agentPrompt: `/bootstrap ${ticket}`,
    });
  } else {
    add(STEPS.bootstrap, 'RUN', `/bootstrap ${t}`, 'No worktree found', {
      agentType: 'skill',
      agentPrompt: `/bootstrap ${t}`,
    });
  }
};
