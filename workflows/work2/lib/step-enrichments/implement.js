/**
 * Implement step enrichment.
 *
 * Replaces the raw TDD protocol with tdd-next.js read-only instructions
 * and forces delegation to a developer agent (tdd-phase-state.js is agent-gated).
 */

'use strict';

const path = require('path');

module.exports = function registerImplement(register) {
  register('implement', (entry, ctx) => {
    if (!entry.agentPrompt) return;

    const tddNextPath = path.join(__dirname, '..', '..', 'tdd-next.js');
    const ticket = ctx.ticket || 'TICKET';

    // Extract task number from prompt if present
    const taskMatch = entry.agentPrompt.match(/Task (\d+) of \d+/);
    const taskFlag = taskMatch ? ` --task ${taskMatch[1]}` : '';

    const delegationBlock = [
      '## CRITICAL: Delegate to developer agent',
      '',
      'You MUST delegate implementation to Task(developer-nodejs-tdd).',
      'Do NOT run tdd-phase-state.js yourself — it is agent-gated and WILL be blocked.',
      'Do NOT try different paths — ALL paths are blocked outside developer agents.',
      '',
      'Delegate like this:',
      '```',
      'Task(developer-nodejs-tdd):',
      '  description: "implement <task description>"',
      '  prompt: <pass the full implementation prompt below>',
      '```',
      '',
      '## TDD Phase Helper (read-only)',
      '',
      'The developer agent can check current TDD phase with:',
      '```bash',
      `node "${tddNextPath}" ${ticket}${taskFlag}`,
      '```',
      'This shows: current phase, allowed files, and exact commands to run.',
      'The tdd-phase-state.js commands in the output WILL work from inside the developer agent.',
    ].join('\n');

    // Replace the raw TDD protocol block with delegation instructions
    const tddProtocolStart = entry.agentPrompt.indexOf('TDD protocol (hook-enforced');
    if (tddProtocolStart >= 0) {
      const afterProtocol = entry.agentPrompt.indexOf('\n## ', tddProtocolStart + 1);
      if (afterProtocol >= 0) {
        entry.agentPrompt =
          entry.agentPrompt.slice(0, tddProtocolStart) +
          delegationBlock +
          entry.agentPrompt.slice(afterProtocol);
      } else {
        entry.agentPrompt = entry.agentPrompt.slice(0, tddProtocolStart) + delegationBlock;
      }
    } else {
      // No TDD protocol found — prepend delegation block
      entry.agentPrompt = delegationBlock + '\n\n' + entry.agentPrompt;
    }
  });
};
