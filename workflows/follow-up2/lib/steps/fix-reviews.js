/**
 * Step: fix-reviews — Process review comments one at a time via developer agent.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

module.exports = function registerFixReviews(register) {
  register('fix-reviews', (state, ctx) => {
    if (state.dispatched === 'fix-reviews') return null; // already ran → advance to push-retry

    // Get next unresolved comment
    const commentsScript = path.join(ctx.workScriptsDir, 'follow-up-pr-comments.js');
    let nextComment = null;
    try {
      const result = execFileSync(
        process.execPath,
        [commentsScript, '--next-comment', '--pr', String(state.prNumber || '')],
        { encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], cwd: ctx.worktreeDir }
      );
      nextComment = JSON.parse(result);
    } catch {
      // No more comments or script error → advance
      return null;
    }

    if (!nextComment || nextComment.done) return null; // no comments → advance to push-retry

    state.dispatched = 'fix-reviews';

    return {
      type: 'follow_up_instruction',
      action: 'execute',
      state: { ticket: state.ticketId, currentStep: 'fix-reviews', attempt: state.attempt },
      continue: true,
      delegate: {
        type: 'task',
        agentType: 'developer-nodejs-tdd',
        description: `Address review comment (attempt ${state.attempt})`,
        prompt: [
          '## Address Review Comment',
          '',
          `**Author:** ${nextComment.author || 'unknown'}`,
          `**File:** ${nextComment.path || 'general'}`,
          `**Line:** ${nextComment.line || 'N/A'}`,
          '',
          '### Comment:',
          nextComment.body || '',
          '',
          '### Instructions:',
          '- If the comment is valid: fix the code',
          '- If the comment conflicts with the spec: skip with reason',
          '- Do NOT modify unrelated files',
        ].join('\n'),
        note: 'Pass the prompt directly to the agent.',
      },
    };
  });
};
