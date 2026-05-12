/**
 * Follow-up step enrichment.
 *
 * Rewrites the follow_up step to call follow-up-next.js (script-driven)
 * instead of the old /follow-up-pr skill.
 */

'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function registerFollowUp(register) {
  register('follow_up', (entry, ctx) => {
    const { resolvePluginRoot } = require(path.join(__dirname, '..', 'resolve-plugin-root'));
    const pluginRoot = resolvePluginRoot(__dirname, 4);

    // Two valid layouts:
    //   - Post-PR-360 release: <root>/scripts/workflows/follow-up2/...
    //   - Legacy / dev tree where `workflows -> scripts/workflows` symlink:
    //       <root>/workflows/follow-up2/...
    // Pick whichever exists; default to the post-PR-360 path.
    const candidates = pluginRoot
      ? [
          path.join(pluginRoot, 'scripts', 'workflows', 'follow-up2', 'follow-up-next.js'),
          path.join(pluginRoot, 'workflows', 'follow-up2', 'follow-up-next.js'),
        ]
      : [path.join(__dirname, '..', '..', '..', 'follow-up2', 'follow-up-next.js')];
    const followUpNextPath = candidates.find((p) => fs.existsSync(p)) || candidates[0];

    entry.agentType = 'Bash';
    entry.agentPrompt = `node "${followUpNextPath}" ${ctx.ticket || 'TICKET'} --init`;
  });
};
