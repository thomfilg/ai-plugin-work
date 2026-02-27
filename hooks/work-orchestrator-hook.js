#!/usr/bin/env node

/**
 * work2-orchestrator-hook.js
 *
 * UserPromptSubmit hook that automatically runs the orchestrator
 * when /work2 is invoked, injecting the plan into the context.
 */

const { execSync } = require('child_process');
const path = require('path');
const { appendAction } = require(path.join(__dirname, '..', 'lib', 'work-actions'));

// Use CLAUDE_PLUGIN_ROOT if available, otherwise fallback to __dirname
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.dirname(__dirname);
const ORCHESTRATOR_PATH = path.join(PLUGIN_ROOT, 'hooks', 'work-orchestrator.js');

function main() {
  const userPrompt = process.env.CLAUDE_USER_PROMPT || '';

  // Check if this is a /work2 invocation
  const work2Match = userPrompt.match(/^\s*\/work2\s+(.+)/i);
  if (!work2Match) {
    // Not a /work2 command, let it pass through
    process.exit(0);
  }

  const args = work2Match[1].trim();

  try {
    // Run the orchestrator
    const result = execSync(`node "${ORCHESTRATOR_PATH}" ${args}`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Parse the result
    const plan = JSON.parse(result);

    if (plan.error) {
      console.log(`ORCHESTRATOR ERROR: ${plan.message}`);
      process.exit(0);
    }

    // Log plan generation action
    if (plan.ticket && !plan.ticket.startsWith('TBD')) {
      const runCount = plan.summary?.run || 0;
      const mode = plan.mode || 'unknown';
      const currentStep = plan.currentStep || '1_ticket';
      appendAction(plan.ticket, {
        step: currentStep,
        what: `plan generated (${mode}, ${runCount} RUN)`,
      });
    }

    // Format the plan for injection
    const output = formatPlan(plan);
    console.log(output);

  } catch (err) {
    console.log(`ORCHESTRATOR FAILED: ${err.message}`);
  }

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
    const icon = step.action === 'RUN' ? '🔄' :
                 step.action === 'SKIP' ? '⏭️' : '⏳';
    const cmd = step.command ? ` → ${step.command}` : '';
    lines.push(`    ${icon} ${step.step.padEnd(20)} ${step.action.padEnd(7)} ${step.reason}${cmd}`);
  }
  lines.push('');

  // Summary
  if (plan.summary) {
    lines.push(`  SUMMARY: ${plan.summary.run} RUN, ${plan.summary.skip} SKIP, ${plan.summary.pending} PENDING`);
    lines.push(`  FIRST ACTION: ${plan.summary.firstAction}`);
    if (plan.summary.stepsToRun.length > 0) {
      lines.push(`  STEPS TO RUN: ${plan.summary.stepsToRun.join(' → ')}`);
    }
  }

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════════');
  lines.push('  INSTRUCTIONS: Execute RUN steps in order. Call transition before each.');
  lines.push(`  TRANSITION: node ~/.claude/plugins/local/work-workflow2/hooks/work-orchestrator.js transition ${plan.ticket} <step>`);
  lines.push('═══════════════════════════════════════════════════════════════════');
  lines.push('');

  return lines.join('\n');
}

main();
