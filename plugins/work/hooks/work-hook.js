#!/usr/bin/env node

/**
 * work-hook.js
 *
 * UserPromptSubmit hook that automatically runs the orchestrator
 * when /work is invoked, injecting the plan into the context.
 */

const fs = require('fs');
const path = require('path');
// Resolve paths via the canonical scripts/workflows/... layout. The plugin root
// historically also exposed `workflows -> scripts/workflows` as a committed
// symlink, but relying on it makes these top-level requires throw with
// MODULE_NOT_FOUND (loader:1459) if the symlink is ever missing (clean clone
// without symlinks, copy to a filesystem that strips them, refactor that
// removes it). Use the real path so the hook never depends on the symlink.
const { appendAction } = require(
  path.join(__dirname, '..', 'scripts', 'workflows', 'work', 'lib', 'work-actions')
);
const { logHookError } = require(
  path.join(__dirname, '..', 'scripts', 'workflows', 'lib', 'hook-error-log')
);
const { safeExec } = require(
  path.join(__dirname, '..', 'scripts', 'workflows', 'lib', 'safe-exec')
);
const { resolvePluginRootHonouringEnv } = require(
  path.join(__dirname, '..', 'scripts', 'workflows', 'work', 'lib', 'resolve-plugin-root')
);
const { getRuntime } = require(
  path.join(__dirname, '..', 'scripts', 'workflows', 'lib', 'runtime')
);

// ORCHESTRATOR_PATH below is derived from PLUGIN_ROOT, so the user's
// CLAUDE_PLUGIN_ROOT must be honoured verbatim when probing lands on an
// unrelated install (env-honouring variant). Falls back to __dirname-based
// probing otherwise, and finally to path.dirname when probing fails too.
const PLUGIN_ROOT = resolvePluginRootHonouringEnv(__dirname, 1) || path.dirname(__dirname);
const ORCHESTRATOR_PATH = path.join(
  PLUGIN_ROOT,
  'scripts',
  'workflows',
  'work',
  'engine',
  'work.workflow.js'
);

// Tokenize args string into positional single-token values.
// Quoted multi-word args are NOT supported by design — matches pre-execFileSync
// shell tokenization behavior.
function tokenizeArgs(rawArgs) {
  return rawArgs.split(/\s+/).filter((token) => token.length > 0);
}

// Parse the UserPromptSubmit payload from stdin. Codex never sets
// CLAUDE_USER_PROMPT, so payload.prompt is the only prompt source there;
// on claude the env leg stays first (byte-identity).
function readStdinPayload() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return {};
  }
}

function main() {
  const payload = readStdinPayload();
  const payloadPrompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  const userPrompt = process.env.CLAUDE_USER_PROMPT || payloadPrompt;

  // Check if this is a /work invocation. Match /work followed by whitespace
  // (so /work-implement, /work-pr, /work2 don't trigger this hook). This
  // in-code check is also the self-filter on codex, where UserPromptSubmit
  // matchers are ignored and the hook fires on every prompt.
  const workMatch = userPrompt.match(/^\s*\/work\s+(.+)/i);
  if (!workMatch) {
    process.exit(0);
  }

  // Bridge runtime identity to the orchestrator child (and any libs reading
  // env): codex hook processes carry neither CLAUDE_CODE_SESSION_ID nor a
  // runtime pin, so children would misclassify without this.
  const rt = getRuntime(payload);
  if (!process.env.AGENT_RUNTIME) process.env.AGENT_RUNTIME = rt.name;
  if (
    !process.env.AGENT_SESSION_ID &&
    typeof payload.session_id === 'string' &&
    payload.session_id
  ) {
    process.env.AGENT_SESSION_ID = payload.session_id;
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
