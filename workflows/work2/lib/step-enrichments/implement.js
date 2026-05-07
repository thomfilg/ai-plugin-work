/**
 * Implement step enrichment.
 *
 * Replaces the raw TDD protocol block with tdd-next.js instructions.
 * The developer agent calls tdd-next.js to get phase-specific guidance
 * instead of manually managing tdd-phase-state.js subcommands.
 */

'use strict';

const path = require('path');

module.exports = function registerImplement(register) {
  register('implement', (entry, ctx) => {
    if (!entry.agentPrompt) return;

    const tddNextPath = path.join(__dirname, '..', '..', 'tdd-next.js');
    const ticket = ctx.ticket || 'TICKET';

    // Extract task number from prompt if present (e.g., "Task 1 of 3")
    const taskMatch = entry.agentPrompt.match(/Task (\d+) of \d+/);
    const taskFlag = taskMatch ? ` --task ${taskMatch[1]}` : '';

    const tddBlock = [
      '## TDD Phase Management (script-driven)',
      '',
      'Instead of manually calling tdd-phase-state.js, use tdd-next.js to get your current phase and instructions:',
      '```bash',
      `node "${tddNextPath}" ${ticket}${taskFlag}`,
      '```',
      '',
      'Run this command to see:',
      '- Your current TDD phase (red/green/refactor)',
      '- Which files you can edit (hooks enforce this)',
      '- The exact commands to record evidence and transition',
      '',
      'Call tdd-next.js after each phase transition to get updated instructions.',
      '',
      'The TDD commands in tdd-next.js output are pre-formatted — copy and run them directly.',
    ].join('\n');

    // Replace the raw TDD protocol block with tdd-next.js instructions
    // The TDD protocol starts with "TDD protocol (hook-enforced" or similar
    const tddProtocolStart = entry.agentPrompt.indexOf('TDD protocol (hook-enforced');
    if (tddProtocolStart >= 0) {
      // Find where the TDD protocol ends (next ## heading or end of string)
      const afterProtocol = entry.agentPrompt.indexOf('\n## ', tddProtocolStart + 1);
      if (afterProtocol >= 0) {
        entry.agentPrompt =
          entry.agentPrompt.slice(0, tddProtocolStart) +
          tddBlock +
          entry.agentPrompt.slice(afterProtocol);
      } else {
        entry.agentPrompt = entry.agentPrompt.slice(0, tddProtocolStart) + tddBlock;
      }
    } else {
      // No TDD protocol found — append tdd-next.js block
      entry.agentPrompt += '\n\n' + tddBlock;
    }
  });
};
