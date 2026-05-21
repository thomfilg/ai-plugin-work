/**
 * Follow-up step enrichment.
 *
 * Rewrites the follow_up step to call follow-up-next.js (script-driven)
 * instead of the old /follow-up-pr skill.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { isPrClosedWithoutMerge } = require('../../../lib/pr-state');

function loadWorkState(tasksDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(tasksDir, '.work-state.json'), 'utf8'));
  } catch {
    return null;
  }
}

function buildClosedPrBlocker(ticket) {
  return {
    type: 'work_instruction',
    action: 'blocked',
    reason: 'follow_up: PR was closed without merge — Gate F requires re-planning from brief',
    details:
      'A closed-without-merge PR usually means the previous scope was wrong (often sibling-owned drift). ' +
      'Looping back through `implement` would re-ship the same scope. Gate F forces a re-plan: ' +
      'archive the current artifacts and re-bootstrap.',
    hint: [
      'To re-plan:',
      '  1. Archive the current run (move brief.md / spec.md / tasks.md into `.archive/` under tasksDir).',
      '  2. Re-run `/work ' + (ticket || '<ticket>') + '` — the workflow will re-enter at `brief`.',
      '  3. The brief-writer will fetch a fresh related-tickets manifest and you can choose a different scope.',
    ].join('\n'),
  };
}

module.exports = function registerFollowUp(register) {
  register('follow_up', (entry, ctx) => {
    // Gate F — refuse to loop follow_up when the PR is closed-not-merged.
    const ws = loadWorkState(ctx.tasksDir);
    if (isPrClosedWithoutMerge(ws)) {
      entry._overrideInstruction = buildClosedPrBlocker(ctx.ticket);
      return;
    }

    const { resolvePluginRoot } = require(path.join(__dirname, '..', 'resolve-plugin-root'));
    const pluginRoot = resolvePluginRoot(__dirname, 4);

    // Two valid layouts:
    //   - Post-PR-360 release: <root>/scripts/workflows/follow-up/...
    //   - Legacy / dev tree where `workflows -> scripts/workflows` symlink:
    //       <root>/workflows/follow-up/...
    // Pick whichever exists; default to the post-PR-360 path.
    const candidates = pluginRoot
      ? [
          path.join(pluginRoot, 'scripts', 'workflows', 'follow-up', 'follow-up-next.js'),
          path.join(pluginRoot, 'workflows', 'follow-up', 'follow-up-next.js'),
        ]
      : [path.join(__dirname, '..', '..', '..', 'follow-up', 'follow-up-next.js')];
    const followUpNextPath = candidates.find((p) => fs.existsSync(p)) || candidates[0];

    entry.agentType = 'Bash';
    entry.agentPrompt = `node "${followUpNextPath}" ${ctx.ticket || 'TICKET'} --init`;
  });
};
