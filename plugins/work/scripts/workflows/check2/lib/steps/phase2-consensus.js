/**
 * Step: 6_phase2_consensus — Iterative consensus loop.
 *
 * If code-review has suggestions:
 *   1. Dispatch developer to fix
 *   2. Archive old report → code-review.run${n}.md
 *   3. Dispatch code-checker for fresh review
 *   4. Repeat up to 3 iterations
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// True when the code review flags unresolved IMPORTANT/CRITICAL items and is
// not already APPROVED. Missing/unreadable report → no suggestions (skip).
function reviewHasSuggestions(crPath) {
  try {
    const cr = fs.readFileSync(crPath, 'utf8');
    return /🟡\s*IMPORTANT|🔴\s*CRITICAL/i.test(cr) && !/Status:\s*APPROVED/i.test(cr);
  } catch {
    return false; // no code review → skip
  }
}

// Pick the developer agent from affected-file analysis, falling back to the
// node TDD developer when the helper is unavailable or returns nothing.
function resolveDeveloperAgent(ctx, state) {
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
      return `work-workflow:${devResult.developers[0]}`;
    }
  } catch {
    /* fallback */
  }
  return 'work-workflow:developer-nodejs-tdd';
}

// Archive the current review report → code-review.run${iteration}.md. Fail-open.
function archiveReport(crPath, reportFolder, iteration) {
  try {
    fs.renameSync(crPath, path.join(reportFolder, `code-review.run${iteration}.md`));
  } catch {
    /* fail-open */
  }
}

function buildDevFixDelegate(state, crPath, developerAgent) {
  return {
    type: 'check_instruction',
    action: 'execute',
    state: { ticket: state.ticketId, currentStep: '6_phase2_consensus', progress: '6/9' },
    continue: true,
    delegate: {
      type: 'task',
      agentType: developerAgent,
      description: `Fix code review suggestions (round ${state.consensusIteration + 1})`,
      prompt: `Fix code review suggestions for ${state.ticketId}. Read ${crPath}. For each suggestion: IMPLEMENT if valid, SKIP with reason if not.`,
      note: 'Pass the prompt directly to the agent.',
    },
  };
}

function buildFreshReviewDelegate(state, crPath, changesHash) {
  return {
    type: 'check_instruction',
    action: 'execute',
    state: { ticket: state.ticketId, currentStep: '6_phase2_consensus', progress: '6/9' },
    continue: true,
    delegate: {
      type: 'task',
      agentType: 'work-workflow:code-checker',
      description: `Fresh code review (round ${state.consensusIteration + 1})`,
      prompt: `Review code changes for ${state.ticketId}. Write report to ${crPath}. Changes hash: ${changesHash}. This is a fresh review — evaluate current code state.`,
      note: 'Pass the prompt directly to the agent.',
    },
  };
}

module.exports = function registerPhase2(register) {
  register('6_phase2_consensus', (state, ctx) => {
    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const crPath = path.join(reportFolder, 'code-review.check.md');
    const changesHash = state.changesHash || 'unknown';

    if (!reviewHasSuggestions(crPath)) return null; // auto-advance
    if (state.consensusIteration >= 3) return null; // max iterations → advance

    const developerAgent = resolveDeveloperAgent(ctx, state);

    // Sub-step 1: dispatch developer to fix suggestions
    if (!state.dispatched || state.dispatched === '6_consensus_reviewed') {
      state.dispatched = '6_consensus_dev';
      return buildDevFixDelegate(state, crPath, developerAgent);
    }

    // Sub-step 2: archive old report + request fresh review
    if (state.dispatched === '6_consensus_dev') {
      state.consensusIteration++;
      archiveReport(crPath, reportFolder, state.consensusIteration);
      state.dispatched = '6_consensus_reviewed';
      return buildFreshReviewDelegate(state, crPath, changesHash);
    }

    return null;
  });
};
