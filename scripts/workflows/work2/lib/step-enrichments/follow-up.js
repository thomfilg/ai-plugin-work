/**
 * Follow-up step enrichment.
 *
 * Rewrites the follow_up step to call follow-up-next.js (script-driven)
 * instead of the old /follow-up-pr skill.
 */

'use strict';

const path = require('path');

module.exports = function registerFollowUp(register) {
  register('follow_up', (entry, ctx) => {
    const { resolvePluginRoot } = require(path.join(__dirname, '..', 'resolve-plugin-root'));
    const pluginRoot = resolvePluginRoot(__dirname, 4);
    const followUpNextPath = path.join(pluginRoot, 'workflows', 'follow-up2', 'follow-up-next.js');

    entry.agentType = 'Bash';
    entry.agentPrompt = `node "${followUpNextPath}" ${ctx.ticket || 'TICKET'} --init`;
  });
};
