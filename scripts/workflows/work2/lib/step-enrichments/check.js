/**
 * Check step enrichment.
 *
 * Rewrites the check step to invoke /check2 skill
 * instead of the old /check skill.
 */

'use strict';

module.exports = function registerCheck(register) {
  register('check', (entry, ctx) => {
    entry.agentType = 'skill';
    entry.agentPrompt = `/work-workflow:check2 ${ctx.ticket || 'TICKET'}`;
  });
};
