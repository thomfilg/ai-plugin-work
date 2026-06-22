#!/usr/bin/env node

/**
 * work-hook.js
 *
 * UserPromptSubmit hook that automatically runs the orchestrator
 * when /work is invoked, injecting the plan into the context.
 */

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
const { maybeUpdateBanner } = require(
  path.join(__dirname, '..', 'scripts', 'workflows', 'work', 'lib', 'update-check')
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

// Build maybeUpdateBanner() options from the environment. The default path
// injects nothing (real cache + real HTTPS fetch). Test-only env seams let a
// spawned-hook integration test supply a deterministic version source without
// touching the network:
//   WORK_UPDATE_CHECK_TEST_LATEST=<X.Y.Z> → fetch shim resolving that version
//   WORK_UPDATE_CHECK_TEST_FAIL=1         → fetch shim that throws (offline)
//   WORK_UPDATE_CHECK_MARKER_DIR=<dir>    → isolate the per-session marker dir
function buildBannerOpts() {
  const opts = {};
  // De-dup the banner PER Claude session, not per machine. Claude Code exposes
  // the session identifier to hooks via CLAUDE_SESSION_ID; thread it through so
  // each session gets its own marker file. When absent, update-check.js keeps
  // its `|| 'default'` safety net (shared marker) rather than crashing.
  if (process.env.CLAUDE_SESSION_ID) {
    opts.sessionId = process.env.CLAUDE_SESSION_ID;
  }
  if (process.env.WORK_UPDATE_CHECK_MARKER_DIR) {
    opts.markerDir = process.env.WORK_UPDATE_CHECK_MARKER_DIR;
  }
  if (process.env.WORK_UPDATE_CHECK_TEST_FAIL === '1') {
    opts.fetch = () => Promise.reject(new Error('injected offline'));
  } else if (process.env.WORK_UPDATE_CHECK_TEST_LATEST) {
    const latest = process.env.WORK_UPDATE_CHECK_TEST_LATEST;
    opts.fetch = () =>
      Promise.resolve({ status: 200, body: JSON.stringify({ metadata: { version: latest } }) });
  }
  return opts;
}

// Prepend the (possibly empty) update banner to the plan output. Empty banner
// leaves the plan byte-for-byte unchanged so the no-banner path is identical to
// the pre-GH-314 behavior.
function prependBanner(banner, output) {
  return banner ? `${banner}\n${output}` : output;
}

// Resolve the (non-blocking) update banner. Fail-open: any error is logged and
// swallowed so the orchestrator plan always renders. Returns '' on no-banner.
async function resolveBanner() {
  try {
    return (await maybeUpdateBanner(buildBannerOpts())) || '';
  } catch (err) {
    logHookError(__filename, err);
    return '';
  }
}

// Record a "plan generated" action for real tickets (TBD placeholders skipped).
function logPlanGenerated(plan) {
  if (!plan.ticket || plan.ticket.startsWith('TBD')) return;
  const runCount = plan.summary?.run || 0;
  const mode = plan.mode || 'unknown';
  const currentStep = plan.currentStep || 'ticket';
  appendAction(plan.ticket, {
    step: currentStep,
    what: `plan generated (${mode}, ${runCount} RUN)`,
  });
}

async function main() {
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

  logPlanGenerated(plan);

  // Format the plan for injection. Prepend the non-blocking update banner
  // (empty when there is nothing to show). The banner is additive — it never
  // delays or aborts plan emission, and the hook still exits 0.
  const banner = await resolveBanner();
  const output = formatPlan(plan);
  console.log(prependBanner(banner, output));

  process.exit(0);
}

// Map a step action to its display icon.
function stepIcon(action) {
  if (action === 'RUN') return '🔄';
  if (action === 'SKIP') return '⏭️';
  if (action === 'DEFER') return '🔮';
  return '⏳';
}

// Build the STATE summary block as an array of lines.
function formatStateLines(state) {
  const lines = ['  STATE:'];
  lines.push(
    state.worktreeExists
      ? `    Worktree: EXISTS (branch: ${state.branch})`
      : '    Worktree: NOT FOUND'
  );
  if (state.pr) {
    lines.push(`    PR: #${state.pr.number} (draft: ${state.pr.isDraft})`);
  }
  if (state.hasDiffVsMain) {
    lines.push(`    Changes: ${state.diffSummary}`);
  }
  if (state.hasUncommitted) {
    lines.push(`    Uncommitted: ${state.uncommittedCount} file(s)`);
  }
  lines.push('');
  return lines;
}

// Build the SUMMARY block as an array of lines.
function formatSummaryLines(summary) {
  const lines = [];
  lines.push(
    `  SUMMARY: ${summary.run} RUN, ${summary.defer || 0} DEFER, ${summary.skip} SKIP, ${summary.pending} PENDING`
  );
  lines.push(`  FIRST ACTION: ${summary.firstAction}`);
  if (summary.stepsToRun.length > 0) {
    lines.push(`  STEPS TO RUN: ${summary.stepsToRun.join(' → ')}`);
  }
  if (summary.stepsDeferred && summary.stepsDeferred.length > 0) {
    lines.push(`  STEPS DEFERRED: ${summary.stepsDeferred.join(' → ')}`);
  }
  return lines;
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
    lines.push(...formatStateLines(plan.state));
  }

  // Plan steps
  lines.push('  PLAN:');
  for (const step of plan.plan) {
    const icon = stepIcon(step.action);
    const cmd = step.command ? ` → ${step.command}` : '';
    lines.push(`    ${icon} ${step.step.padEnd(20)} ${step.action.padEnd(7)} ${step.reason}${cmd}`);
  }
  lines.push('');

  // Summary
  if (plan.summary) {
    lines.push(...formatSummaryLines(plan.summary));
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

// Fail-open: a rejected main() must never crash the hook (exit non-zero).
main().catch((err) => {
  logHookError(__filename, err);
  process.exit(0);
});
