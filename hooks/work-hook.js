#!/usr/bin/env node

/**
 * work-hook.js
 *
 * UserPromptSubmit hook that automatically runs the orchestrator
 * when /work is invoked, injecting the plan into the context.
 */

const path = require('path');
const { appendAction } = require(
  path.join(__dirname, '..', 'workflows', 'work', 'lib', 'work-actions')
);
const { logHookError } = require(path.join(__dirname, '..', 'workflows', 'lib', 'hook-error-log'));
const { safeExec } = require(path.join(__dirname, '..', 'workflows', 'lib', 'safe-exec'));

// Use CLAUDE_PLUGIN_ROOT if available, otherwise fallback to __dirname
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(__dirname);
const ORCHESTRATOR_PATH = path.join(PLUGIN_ROOT, 'workflows', 'work', 'engine', 'work.workflow.js');

// Tokenize args string into positional single-token values.
// Quoted multi-word args are NOT supported by design — matches pre-execFileSync
// shell tokenization behavior.
function tokenizeArgs(rawArgs) {
  return rawArgs.split(/\s+/).filter((token) => token.length > 0);
}

function main() {
  const userPrompt = process.env.CLAUDE_USER_PROMPT || '';

  // Check if this is a /work invocation. Match /work followed by whitespace
  // (so /work-implement, /work-pr, /work2 don't trigger this hook).
  const workMatch = userPrompt.match(/^\s*\/work\s+(.+)/i);
  if (!workMatch) {
    process.exit(0);
  }

  const args = workMatch[1].trim();
  // Tokenize via the named helper to make the intent obvious at the call site.
  // See tokenizeArgs() above for the scope-constraint rationale.
  const parsedArgs = tokenizeArgs(args);

  // Run the orchestrator via safeExec (uses execFileSync internally, no shell).
  // Use a null fallback so we can distinguish a failure from empty output.
  const result = safeExec(process.execPath, [ORCHESTRATOR_PATH, ...parsedArgs], {
    timeout: 30000,
    fallback: null,
  });

  if (result === null) {
    logHookError(__filename, new Error('orchestrator invocation failed'));
    console.log('ORCHESTRATOR FAILED: command returned null');
    process.exit(0);
  }

  let plan;
  try {
    plan = JSON.parse(result);
  } catch (err) {
    logHookError(__filename, err);
    console.log(`ORCHESTRATOR FAILED: ${err.message}`);
    process.exit(0);
  }

  if (plan.error) {
    console.log(`ORCHESTRATOR ERROR: ${plan.message}`);
    process.exit(0);
  }

  // Log plan generation action
  if (plan.ticket && !plan.ticket.startsWith('TBD')) {
    const runCount = plan.summary?.run || 0;
    const mode = plan.mode || 'unknown';
    const currentStep = plan.currentStep || 'ticket';
    appendAction(plan.ticket, {
      step: currentStep,
      what: `plan generated (${mode}, ${runCount} RUN)`,
    });
  }

  // Format the plan for injection
  const output = formatPlan(plan);
  console.log(output);

  process.exit(0);
}

function formatPlan(plan) {
  const lines = [];

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════════');
  lines.push(`  WORK2 ORCHESTRATOR PLAN: ${plan.ticket}`);
  lines.push(`  Mode: ${plan.mode} | Current Step: ${plan.currentStep || 'unknown'}`);
  lines.push('═══════════════════════════════════════════════════════════════════');
  lines.push('');

  // State summary
  if (plan.state) {
    lines.push('  STATE:');
    if (plan.state.worktreeExists) {
      lines.push(`    Worktree: EXISTS (branch: ${plan.state.branch})`);
    } else {
      lines.push('    Worktree: NOT FOUND');
    }
    if (plan.state.pr) {
      lines.push(`    PR: #${plan.state.pr.number} (draft: ${plan.state.pr.isDraft})`);
    }
    if (plan.state.hasDiffVsMain) {
      lines.push(`    Changes: ${plan.state.diffSummary}`);
    }
    if (plan.state.hasUncommitted) {
      lines.push(`    Uncommitted: ${plan.state.uncommittedCount} file(s)`);
    }
    lines.push('');
  }

  // Plan steps
  lines.push('  PLAN:');
  for (const step of plan.plan) {
    const icon =
      step.action === 'RUN'
        ? '🔄'
        : step.action === 'SKIP'
          ? '⏭️'
          : step.action === 'DEFER'
            ? '🔮'
            : '⏳';
    const cmd = step.command ? ` → ${step.command}` : '';
    lines.push(`    ${icon} ${step.step.padEnd(20)} ${step.action.padEnd(7)} ${step.reason}${cmd}`);
  }
  lines.push('');

  // Summary
  if (plan.summary) {
    lines.push(
      `  SUMMARY: ${plan.summary.run} RUN, ${plan.summary.defer || 0} DEFER, ${plan.summary.skip} SKIP, ${plan.summary.pending} PENDING`
    );
    lines.push(`  FIRST ACTION: ${plan.summary.firstAction}`);
    if (plan.summary.stepsToRun.length > 0) {
      lines.push(`  STEPS TO RUN: ${plan.summary.stepsToRun.join(' → ')}`);
    }
    if (plan.summary.stepsDeferred && plan.summary.stepsDeferred.length > 0) {
      lines.push(`  STEPS DEFERRED: ${plan.summary.stepsDeferred.join(' → ')}`);
    }
  }

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════════');
  lines.push(
    '  INSTRUCTIONS: Execute RUN steps in order. DEFER steps: re-run plan first to resolve to RUN/SKIP.'
  );
  lines.push(
    `  TRANSITION: node ${PLUGIN_ROOT}/scripts/workflows/work/engine/work.workflow.js transition ${plan.ticket} <step>`
  );
  lines.push('═══════════════════════════════════════════════════════════════════');
  lines.push('');

  return lines.join('\n');
}

main();
