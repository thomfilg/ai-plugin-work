/**
 * Step: fix-ci — Delegate developer agent to fix CI failures or conflicts.
 */

'use strict';

module.exports = function registerFixCi(register) {
  register('fix-ci', (state) => {
    if (state.dispatched === 'fix-ci') return null; // already ran → advance to push-retry

    state.dispatched = 'fix-ci';
    const category = state.failureCategory || 'ci_failure';
    const output = (state.lastMonitorResult?.output || '').substring(0, 1000);

    return {
      type: 'follow_up_instruction',
      action: 'execute',
      state: { ticket: state.ticketId, currentStep: 'fix-ci', attempt: state.attempt },
      continue: true,
      delegate: {
        type: 'task',
        agentType: 'developer-nodejs-tdd',
        description: `Fix ${category} (attempt ${state.attempt})`,
        prompt: [
          `## Fix ${category === 'conflict' ? 'Merge Conflict' : 'CI Failure'}`,
          '',
          `PR #${state.prNumber || 'unknown'} has a ${category}. Fix it.`,
          '',
          '### Monitor output (truncated):',
          '```',
          output,
          '```',
          '',
          category === 'ci_failure'
            ? 'Read the failed CI logs with `gh run view <RUN_ID> --log-failed` and fix the root cause.'
            : 'Resolve the merge conflict and ensure tests pass.',
        ].join('\n'),
        note: 'Pass the prompt directly to the agent.',
      },
    };
  });
};
