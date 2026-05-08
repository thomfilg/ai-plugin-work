/**
 * Check step enrichment.
 *
 * Rewrites the check step to call check-next.js (script-driven /check2)
 * instead of the old /check skill.
 */

'use strict';

const path = require('path');

module.exports = function registerCheck(register) {
  register('check', (entry, ctx) => {
    const { resolvePluginRoot } = require(path.join(__dirname, '..', 'resolve-plugin-root'));
    const pluginRoot = resolvePluginRoot(__dirname, 4);
    const checkNextPath = path.join(pluginRoot, 'workflows', 'check2', 'check-next.js');

    entry.agentType = 'Bash';
    entry.agentPrompt = `node "${checkNextPath}" ${ctx.ticket || 'TICKET'} --init`;
  });
};
