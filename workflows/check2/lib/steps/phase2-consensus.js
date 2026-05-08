/**
 * Step: 5_phase2_consensus — Iterative consensus loop.
 *
 * Reads code-review.check.md for suggestions. If found:
 *   1. Dispatches developer agent to evaluate/implement
 *   2. Dispatches code-checker to validate
 *   3. Repeats up to 3 iterations
 *
 * Auto-advances if no suggestions or max iterations reached.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = function registerPhase2(register) {
  register('5_phase2_consensus', (state, ctx) => {
    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const crPath = path.join(reportFolder, 'code-review.check.md');

    // Check if code review has suggestions
    let hasSuggestions = false;
    try {
      const cr = fs.readFileSync(crPath, 'utf8');
      hasSuggestions = /🟡\s*IMPORTANT|🔴\s*CRITICAL/i.test(cr) && !/Status:\s*APPROVED/i.test(cr);
    } catch {
      /* no code review → skip */
    }

    if (!hasSuggestions) return null; // auto-advance

    if (state.consensusIteration >= 3) return null; // max iterations → advance

    // Determine developer agent
    let developerAgent = 'developer-nodejs-tdd';
    try {
      const result = execFileSync(
        process.execPath,
        [
          path.join(ctx.checkHooksDir, 'check-determine-developers.js'),
          JSON.stringify(state.setupResult?.affectedFiles || {}),
        ],
        { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
      );
      const devResult = JSON.parse(result);
      if (devResult.developers && devResult.developers.length > 0) {
        developerAgent = devResult.developers[0];
      }
    } catch {
      /* fallback */
    }

    // Sub-step: developer evaluates
    if (!state.dispatched || state.dispatched === '5_phase2_consensus_validate') {
      state.dispatched = '5_phase2_consensus_dev';
      return {
        type: 'check_instruction',
        action: 'execute',
        state: { ticket: state.ticketId, currentStep: '5_phase2_consensus', progress: '5/9' },
        continue: true,
        delegate: {
          type: 'task',
          agentType: developerAgent,
          description: 'Evaluate code review suggestions',
          prompt: `Evaluate code review suggestions for ${state.ticketId}. Read ${reportFolder}/code-review.check.md. For each suggestion: IMPLEMENT if valid, SKIP with reason if not.`,
          note: 'Pass the prompt directly to the agent.',
        },
      };
    }

    // Sub-step: code-checker validates
    if (state.dispatched === '5_phase2_consensus_dev') {
      state.dispatched = '5_phase2_consensus_validate';
      state.consensusIteration++;
      return {
        type: 'check_instruction',
        action: 'execute',
        state: { ticket: state.ticketId, currentStep: '5_phase2_consensus', progress: '5/9' },
        continue: true,
        delegate: {
          type: 'task',
          agentType: 'code-checker',
          description: `Validate consensus (iteration ${state.consensusIteration})`,
          prompt: `Validate the developer's response to code review suggestions for ${state.ticketId}. Read ${reportFolder}/code-review.check.md and the developer reply.`,
          note: 'Pass the prompt directly to the agent.',
        },
      };
    }

    return null; // fallthrough → advance
  });
};
