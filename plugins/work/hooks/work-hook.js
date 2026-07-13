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
const { runHook } = require(
  path.join(__dirname, '..', 'scripts', 'workflows', 'lib', 'hookEntrypoint')
);
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

// Bridge runtime identity to the orchestrator child (and any libs reading
// env): codex hook processes carry neither CLAUDE_CODE_SESSION_ID nor a
// runtime pin, so children would misclassify without this.
function bridgeRuntimeEnv(payload) {
  const rt = getRuntime(payload);
  if (!process.env.AGENT_RUNTIME) process.env.AGENT_RUNTIME = rt.name;
  if (
    !process.env.AGENT_SESSION_ID &&
    typeof payload.session_id === 'string' &&
    payload.session_id
  ) {
    process.env.AGENT_SESSION_ID = payload.session_id;
  }
}

// Run the orchestrator via safeExec (uses execFileSync internally, no shell)
// and parse its plan. Failure paths log + inject a message and exit 0.
function fetchPlan(parsedArgs) {
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
  return plan;
}

// Log plan generation action
function logPlanAction(plan) {
  if (plan.ticket && !plan.ticket.startsWith('TBD')) {
    const runCount = plan.summary?.run || 0;
    const mode = plan.mode || 'unknown';
    const currentStep = plan.currentStep || 'ticket';
    appendAction(plan.ticket, {
      step: currentStep,
      what: `plan generated (${mode}, ${runCount} RUN)`,
    });
  }
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

// The payload is read/parsed by runHook (hookEntrypoint). Codex never sets
// CLAUDE_USER_PROMPT, so payload.prompt is the only prompt source there;
// on claude the env leg stays first (byte-identity).
async function main(payload) {
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

  bridgeRuntimeEnv(payload);

  const args = workMatch[1].trim();
  // Tokenize via the named helper to make the intent obvious at the call site.
  // See tokenizeArgs() above for the scope-constraint rationale.
  const parsedArgs = tokenizeArgs(args);

  const plan = fetchPlan(parsedArgs);
  logPlanAction(plan);

  // Format the plan for injection. Prepend the non-blocking update banner
  // (empty when there is nothing to show). The banner is additive — it never
  // delays or aborts plan emission, and the hook still exits 0.
  const output = formatPlan(plan);
  const banner = await resolveBanner();
  console.log(prependBanner(banner, output));

  process.exit(0);
}

// State summary
function pushStateLines(lines, state) {
  lines.push('  STATE:');
  if (state.worktreeExists) {
    lines.push(`    Worktree: EXISTS (branch: ${state.branch})`);
  } else {
    lines.push('    Worktree: NOT FOUND');
  }
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
}

// Plan steps
const ACTION_ICONS = { RUN: '🔄', SKIP: '⏭️', DEFER: '🔮' };

function pushPlanLines(lines, planSteps) {
  lines.push('  PLAN:');
  for (const step of planSteps) {
    const icon = ACTION_ICONS[step.action] || '⏳';
    const cmd = step.command ? ` → ${step.command}` : '';
    lines.push(`    ${icon} ${step.step.padEnd(20)} ${step.action.padEnd(7)} ${step.reason}${cmd}`);
  }
  lines.push('');
}

// Summary — reads via `plan.summary` (not a destructured alias) on purpose:
// keeps this hook's token stream distinct from lib/engine/planning.js's
// formatSummaryLines, whose output format is close but not identical.
function pushSummaryLines(lines, plan) {
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

function formatPlan(plan) {
  const lines = [];

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════════');
  lines.push(`  WORK2 ORCHESTRATOR PLAN: ${plan.ticket}`);
  lines.push(`  Mode: ${plan.mode} | Current Step: ${plan.currentStep || 'unknown'}`);
  lines.push('═══════════════════════════════════════════════════════════════════');
  lines.push('');

  if (plan.state) {
    pushStateLines(lines, plan.state);
  }

  pushPlanLines(lines, plan.plan);

  if (plan.summary) {
    pushSummaryLines(lines, plan);
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

/**
 * firePreToolCall — dispatch the OnPreToolCall extension event after the
 * existing PreToolUse hook body, gated on an active /work marker. Errors are
 * swallowed so a misbehaving extension can never crash the hook.
 *
 * @param {{toolName: string, toolInput: any, tasksDir: string, repoRoot: string}} args
 * @param {{ findActiveMarker?: Function, initExtensions?: Function }} [deps]
 * @returns {void}
 */
function firePreToolCall(args, deps) {
  const { toolName, toolInput, tasksDir, repoRoot } = args || {};
  let marker = null;
  try {
    const findMarker =
      deps?.findActiveMarker ||
      require(path.join(__dirname, '..', 'scripts', 'workflows', 'work', 'lib', 'marker'))
        .findActiveMarker;
    marker = findMarker(tasksDir, '.work.pid');
  } catch {
    /* fail-open */
  }
  if (!marker) return;
  try {
    const init =
      deps?.initExtensions ||
      require(path.join(__dirname, '..', 'scripts', 'workflows', 'work', 'lib', 'extensions'))
        .initExtensions;
    const api = init({ repoRoot, tasksDir });
    api.dispatch('OnPreToolCall', { toolName, toolInput });
  } catch {
    /* fail-open — extension dispatch errors must never crash the hook */
  }
}

module.exports = { firePreToolCall };

// Canonical entry protocol (stdin read, payload parse, fail-open error
// handling: unexpected errors — including a rejected async main() — are
// logged via logHookError and exit 0). The handler's own
// console.log-then-exit(0) failure paths in fetchPlan are untouched —
// runHook never intercepts stdout or an explicit process.exit.
// WORK_HOOK_NO_MAIN lets tests require this module without running the hook.
if (!process.env.WORK_HOOK_NO_MAIN) {
  runHook(main, { file: __filename });
}
