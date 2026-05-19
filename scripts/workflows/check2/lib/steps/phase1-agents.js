/**
 * Step: 5_phase1_agents — Launch code-checker and completion-checker in parallel.
 * Tests are already handled by 4_run_tests (deterministic script).
 *
 * Uses the same delegates pattern as implement step for clarity.
 * Returns a parallel instruction with exact prompts per agent.
 * On subsequent calls, checks if reports exist and auto-advances.
 */

'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function registerPhase1(register) {
  register('5_phase1_agents', (state, ctx) => {
    const reportFolder = state.setupResult?.reportFolder || ctx.tasksDir;
    const changesHash = state.changesHash || 'unknown';

    // Already dispatched — check if reports exist
    if (state.dispatched === '5_phase1_agents') {
      const hasCodeReview = fs.existsSync(path.join(reportFolder, 'code-review.check.md'));
      const completionPath = path.join(reportFolder, 'completion.check.md');
      const hasCompletion = fs.existsSync(completionPath);
      if (hasCodeReview && hasCompletion) {
        // Mark tasks as verified [v] if completion-checker says COMPLETE
        try {
          const completionReport = fs.readFileSync(completionPath, 'utf8');
          const { hasVerdict } = require(
            path.join(__dirname, '..', '..', '..', 'lib', 'parse-completion-status')
          );
          if (hasVerdict(completionReport, ['COMPLETE'])) {
            const { markVerified } = require(
              path.join(__dirname, '..', '..', '..', 'work2', 'lib', 'mark-task-progress')
            );
            markVerified(ctx.tasksDir);
          }
        } catch {
          /* fail-open */
        }
        return null; // all reports present → auto-advance
      }
    }

    state.dispatched = '5_phase1_agents';

    // Build structured verification context from planning artifacts
    let completionContext = '';
    try {
      const { buildCompletionContext } = require(
        path.join(__dirname, '..', 'step-enrichments', 'completion-context')
      );
      completionContext = buildCompletionContext(ctx.tasksDir, state.ticketId);
    } catch {
      completionContext = '(Could not load planning artifacts — verify against PR diff only)';
    }

    const codeReviewReport = path.join(reportFolder, 'code-review.check.md');
    const completionReport = path.join(reportFolder, 'completion.check.md');

    const delegates = [
      {
        type: 'task',
        agentType: 'work-workflow:code-checker',
        description: `Code review — ${state.ticketId}`,
        prompt: [
          `## Code Review for ${state.ticketId}`,
          '',
          '### MANDATORY: self-paced runner',
          '',
          `Drive the review through the code-next.js runner. It phases inputs → change_classify → file_coverage → standards_audit → kind_checks → report → memorize → done and writes your verdict into ${codeReviewReport}.`,
          '',
          '```',
          `node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-code-checker/code-next.js ${state.ticketId}`,
          '```',
          '',
          "Follow the runner output verbatim. Re-invoke after performing each phase's action — stop only when it prints `NEXT_ACTION: DONE`.",
          '',
          `Changes hash: ${changesHash}`,
          '',
          '### What to check',
          '- Bugs, logic errors, security vulnerabilities',
          '- Code quality, naming, patterns adherence',
          '- Missing error handling at system boundaries',
          '',
          '### Rules',
          '- Do NOT run tests (already handled by deterministic script)',
          '- Do NOT modify any code — only review and report',
        ].join('\n'),
        note: 'Pass the prompt directly to the agent.',
      },
      {
        type: 'task',
        agentType: 'work-workflow:completion-checker',
        description: `Verify requirements — ${state.ticketId}`,
        prompt: [
          `## Verify ALL requirements for ${state.ticketId}`,
          '',
          '### MANDATORY: self-paced runner',
          '',
          `Drive verification through the completion-next.js runner. It phases inputs → requirements_extract → diff_scope → coverage_check → kind_checks → report → memorize → done and writes your verdict into ${completionReport}.`,
          '',
          '```',
          `node $CLAUDE_PLUGIN_ROOT/scripts/workflows/work-completion-checker/completion-next.js ${state.ticketId}`,
          '```',
          '',
          "Follow the runner output verbatim. Re-invoke after performing each phase's action — stop only when it prints `NEXT_ACTION: DONE`.",
          '',
          `Changes hash: ${changesHash}`,
          '',
          '# Verification Context (pre-loaded from planning artifacts)',
          '',
          completionContext,
          '',
          '# Instructions',
          '',
          'Verify each layer in order (ticket → brief → spec → tasks).',
          'For EACH requirement/deliverable: grep or read the actual code to find evidence.',
          'Mark DELIVERED only with a code citation (file:line or diff excerpt).',
          'Mark INCOMPLETE if any P0 requirement lacks code evidence.',
        ].join('\n'),
        note: 'Pass the prompt directly to the agent.',
      },
    ];

    return {
      type: 'check_instruction',
      action: 'execute',
      state: { ticket: state.ticketId, currentStep: '5_phase1_agents', progress: '5/9' },
      continue: true,
      parallel: true,
      delegates,
      note: `Launch EXACTLY these ${delegates.length} agents IN PARALLEL (single message, ${delegates.length} Task tool calls). Do NOT add any other agents — tests are handled by a deterministic script.`,
    };
  });
};
