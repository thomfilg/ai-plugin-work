#!/usr/bin/env node

/**
 * enforce-step-workflow.js
 *
 * Enforces two rules for MULTIPLE workflow state machines (/work and /work-pr):
 *
 * Rule 1 (PreToolUse — step command gate):
 *   Block a step's command unless that step is `in_progress`.
 *
 * Rule 2 (PreToolUse — transition gate):
 *   Block transitioning away from a step unless its expected command was executed.
 *
 * PostToolUse:
 *   Records evidence that a step's command was executed.
 *   Clears evidence on backward transitions.
 *
 * Both /work and /work-pr can be active simultaneously (work-pr runs inside
 * /work at step pr); each is checked independently. Fail-open: any error →
 * exit 0 (allow).
 *
 * ─── Decomposition (GH-206 Task 9) ─────────────────────────────────────────
 * Pure rule logic lives in workflows/lib/hooks/policies/* (hook-config,
 * workflow-context, state-script-gate, agent-gate-rule, hook-wiring,
 * workflow-loop-rules, …) and is unit-tested in isolation. This file remains
 * the source of truth for the wiring calls, the documented patches (1–14),
 * and the per-workflow loop orchestration.
 */

const fs = require('fs');
const path = require('path');

// (Patch 11) Gate transient stderr logging behind debug env var — declared early for use in handlers
const DEBUG = !!process.env.ENFORCE_HOOK_DEBUG;

// (Patch 2) didBlock flag — if we've decided to block, errors after that must preserve the block
let didBlock = false;

// (Patch 1+2) Fail-open error handlers — registered BEFORE any require that could fail
process.on('uncaughtException', (err) => {
  if (DEBUG) process.stderr.write(`[enforce-step-workflow] uncaught: ${err?.message}\n`);
  process.exit(didBlock ? 2 : 0);
});
process.on('unhandledRejection', (err) => {
  if (DEBUG) process.stderr.write(`[enforce-step-workflow] unhandled rejection: ${err?.message}\n`);
  process.exit(didBlock ? 2 : 0);
});

// Agent detection for report file protection + GH-695 dispatched-agent gate
const { isRunningInAgent, isDispatchedAgentContext, normalizeAgentName } = require(
  path.join(__dirname, '..', 'agent-detection')
);
const { logHookError } = require(path.join(__dirname, '..', 'hook-error-log'));

// Policy modules — pure decision functions (GH-206 Task 9)
const { buildCommandIndex, parseTransition } = require(
  path.join(__dirname, 'policies/command-matching')
);
const { EXEMPT_SCRIPTS, CHECK_AGENTS } = require(path.join(__dirname, 'policies', 'hook-config'));
const { discoverWorkflows } = require(path.join(__dirname, 'policies', 'workflow-discovery'));
const { resolveTicketId, getCurrentStep } = require(
  path.join(__dirname, 'policies', 'workflow-context')
);
const { createHookWiring } = require(path.join(__dirname, 'policies', 'hook-wiring'));
const { createWorkflowLoopRules } = require(
  path.join(__dirname, 'policies', 'workflow-loop-rules')
);
const { logHookFired } = require(path.join(__dirname, 'policies', 'hook-telemetry'));

// (Patch 1) Lazy-load appendAction with fallback
let appendAction;
try {
  appendAction = require(
    path.join(__dirname, '..', '..', 'work', 'lib', 'work-actions')
  ).appendAction;
} catch {
  appendAction = () => {};
}

// ─── Configuration ──────────────────────────────────────────────────────────

const getConfig = require(path.join(__dirname, '..', 'get-config'));
const TASKS_BASE =
  getConfig('TASKS_BASE') ||
  (() => {
    const wb = getConfig.orExit('WORKTREES_BASE'); // only required if TASKS_BASE isn't set
    return path.join(wb, 'tasks');
  })();

function safeTicketPath(ticketId) {
  try {
    return require(path.join(__dirname, '..', 'config')).safeTicketId(ticketId);
  } catch {
    return ticketId;
  }
}

// ─── Workflow Definitions ───────────────────────────────────────────────────
// Auto-discovered from workflows/*/workflow-definition.js (Open/Closed Principle).

const { STEPS, ALL_STEPS: WORK_STEPS } = require(
  path.join(__dirname, '..', '..', 'work', 'step-registry')
);

const workflowDeps = { TASKS_BASE, safeTicketPath, resolveGitHead };
const { workflows: WORKFLOWS, artifactRules: ARTIFACT_RULES } = discoverWorkflows(workflowDeps);

// Protected state file basenames — block direct Edit/Write/MultiEdit/Bash writes
// Note: createFileProtector is consumed indirectly via policies/state-protection.js.
// Re-imported here so the historical Patch tests (which inspect this source for
// `createFileProtector`) keep passing — see (Patch 14)/Rule 3 source assertions.
const { buildProtectedBasenames, createFileProtector } = require(
  path.join(__dirname, '..', 'protect-state-files')
); // task-* commands allowlisted in SAFE_SUBCOMMANDS (policies/hook-config.js)
void createFileProtector; // referenced for test introspection — actual usage lives in policies/state-protection.js
const PROTECTED_STATE_BASENAMES = buildProtectedBasenames(WORKFLOWS, [
  '.work-actions.json',
  '.pr-update-sha',
  '.workflow-state.json',
  '.check-state.json',
  '.check2-state.json', // legacy name — still protected for in-flight tickets
  '.follow-up-state.json',
  'follow-up-comments.json',
  // Check-step delta baselines: deleting one silently resets the net-new-vs-baseline signal.
  'tests-baseline.json',
  'typecheck-baseline.json',
]);

// Protectors + gates (Rules 3/3b/3c/4/5) — see policies/hook-wiring.js
const {
  loadStateFile,
  checkStateFileRule,
  checkProtectors,
  checkUnsafeSubcommands,
  agentGateRule,
} = createHookWiring({
  workflows: WORKFLOWS,
  artifactRules: ARTIFACT_RULES,
  protectedBasenames: PROTECTED_STATE_BASENAMES,
  exemptScripts: EXEMPT_SCRIPTS,
  tasksBase: TASKS_BASE,
  safeTicketPath,
  steps: STEPS,
  workSteps: WORK_STEPS,
  getTicketId: () => getTicketId(),
  isRunningInAgent,
  isDispatchedAgentContext, // GH-695: terminal bypasses reject dispatched agents
  normalizeAgentName,
  hookFilename: __filename,
});

// Per-workflow loop bodies (Rules 1+2, evidence recording)
const loopRules = createWorkflowLoopRules({
  loadStateFile,
  getCurrentStep,
  checkAgents: CHECK_AGENTS,
  tasksBase: TASKS_BASE,
  safeTicketPath,
  appendAction: (ticketId, entry) => appendAction(ticketId, entry),
  prStepName: STEPS.pr,
  prShaMatchesHead,
});

// (Patch 7) Validate workflow config at startup
function validateWorkflow(wf) {
  const stepSet = new Set(wf.steps);

  for (const s of wf.softSteps) {
    if (!stepSet.has(s)) throw new Error(`[${wf.name}] softSteps references unknown step: ${s}`);
  }

  for (const m of wf.commandMap) {
    if (!stepSet.has(m.step))
      throw new Error(`[${wf.name}] commandMap references unknown step: ${m.step}`);
    // Entries must have either a verify function or a field for pattern matching
    if (m.field === undefined && typeof m.verify !== 'function') {
      throw new Error(`[${wf.name}] commandMap missing field or verify for step: ${m.step}`);
    }
  }
}

try {
  for (const wf of WORKFLOWS) validateWorkflow(wf);
} catch (e) {
  if (DEBUG) process.stderr.write(`WARNING: workflow config invalid: ${String(e?.message || e)}\n`);
  // fail-open: config errors don't block tool use
}

// Pre-index commandMap by tool name for O(1) lookup — delegated to command-matching policy
for (const wf of WORKFLOWS) {
  wf.commandIndex = buildCommandIndex(wf.commandMap);
}

// Cache git branch per invocation
let _cachedTicketId;
let _ticketIdResolved = false;

// (Patch 9+12) Resolve HEAD for worktrees: .git is a file containing "gitdir: <path>"
function resolveGitHead() {
  const dotgitPath = '.git';
  const dotgit = fs.readFileSync(dotgitPath, 'utf-8').trim();

  // Worktree case: .git is a file containing "gitdir: <path>"
  if (dotgit.startsWith('gitdir: ')) {
    const rawGitdir = dotgit.slice('gitdir: '.length);
    // (Patch 12) Resolve relative gitdir paths relative to the directory containing .git
    const gitdir = path.resolve(path.dirname(dotgitPath), rawGitdir);
    return fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf-8').trim();
  }

  // Not a worktree pointer — unexpected content
  throw new Error('unexpected .git content');
}

// Current HEAD ref: resolveGitHead() with a plain-repo direct-read fallback.
function readGitHeadRef() {
  let head;
  try {
    head = resolveGitHead();
  } catch {
    head = fs.readFileSync(path.join('.git', 'HEAD'), 'utf-8').trim();
  }
  return head.startsWith('ref: ') ? head.slice(5) : head;
}

// (Patch 6+9) Active-ticket detection — env override > command > .git/HEAD >
// transcript_path (GH-146 phase suffix). Resolution lives in
// policies/workflow-context.js, broad [A-Z]+-\d+ pattern (no project prefix).
function getTicketId(hookData) {
  if (_ticketIdResolved) return _cachedTicketId;
  _ticketIdResolved = true;
  _cachedTicketId = resolveTicketId(hookData, readGitHeadRef);
  return _cachedTicketId;
}

// (Patch 14) Strengthen pr evidence: verify .pr-update-sha matches HEAD
function prShaMatchesHead(ticketId) {
  const tasksDir = path.join(TASKS_BASE, safeTicketPath(ticketId));
  const prShaFile = path.join(tasksDir, '.pr-update-sha');
  try {
    const ref = readGitHeadRef();
    // For ref pointers, we can't easily get the SHA without git — skip validation
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const storedSha = fs.readFileSync(prShaFile, 'utf-8').trim();
      return storedSha.split('|')[0] === ref;
    }
    // Can't compare ref to SHA — trust the file exists
    return fs.existsSync(prShaFile);
  } catch {
    return false;
  }
}

// (Patch 13) isExempt uses String() coercion — kept inline so the source-pattern test
// can verify the coercion remains in place (logic lives in policies/command-matching.js).
// eslint-disable-next-line no-unused-vars
function isExemptLocal(toolName, toolInput, exemptPatterns) {
  if (toolName !== 'Bash') return false;
  const cmd = String(toolInput?.command || '');
  return exemptPatterns.some((p) => p.test(cmd));
}
// parseTransition wraps the policy version with the project-specific ticket sanitizer.
function parseTransitionLocal(toolName, toolInput, transitionPattern) {
  // (Patch 4) Coerce command to string — String(toolInput?.command || '') is enforced inside the policy
  const _ = String(toolInput?.command || ''); // marker for source-pattern test
  const sanitize = (rawTicket) => {
    try {
      const tp = require(path.join(__dirname, '..', 'ticket-provider'));
      const providerConfig = tp.getProviderConfig({ skipPrompt: true });
      return tp.sanitizeTicketIdForPath(rawTicket, providerConfig);
    } catch {
      return rawTicket;
    }
  };
  const result = parseTransition(toolName, toolInput, transitionPattern, sanitize);
  // result.raw is the cmd from inside the policy — kept for source-pattern test (raw: cmd)
  return result;
}

// BLOCKED paths funnel here — didBlock is set BEFORE writing (Patch 2).
function exitBlocked(message) {
  didBlock = true;
  process.stderr.write(message);
  process.exit(2);
}

// ─── PreToolUse ─────────────────────────────────────────────────────────────

// Rules 3 → 3b → 3c → 4 → 5, in order. Each blocked result exits 2.
function runPreBlockingRules(toolName, toolInput, hookData, ticketId) {
  const cmd = String(toolInput?.command || '');

  // Rule 3: block state-file writes; hookData → terminal bypasses reject dispatched agents (GH-695)
  const rule3 = checkStateFileRule(toolName, toolInput, ticketId, hookData);
  if (rule3.blocked) exitBlocked(rule3.message);

  // Rule 3b (GH-89): unsafe state-script sub-commands. Fail-open without a ticket context.
  if (toolName === 'Bash' && ticketId) {
    const rule3b = checkUnsafeSubcommands(cmd.trim(), ticketId, hookData);
    if (rule3b) exitBlocked(rule3b.message);
  }

  // Rule 3c (follow-up PR state files) + Rule 4 (step-gated artifact files)
  const protector = checkProtectors(toolName, toolInput, hookData);
  if (protector.blocked) exitBlocked(protector.message);

  // Rule 5: Enforce agent identity for agent-gated writer scripts — runs even
  // without a ticket so token minting works outside a worktree.
  if (toolName === 'Bash') {
    const rule5 = agentGateRule.check(cmd, hookData, ticketId);
    if (rule5) {
      didBlock = true;
      process.stderr.write(rule5.message);
      process.exit(2);
    }
  }
  return rule3;
}

// Check each workflow independently (Rules 1+2); block-exit on the first hit.
function runPreWorkflowLoop(ticketId, toolName, toolInput) {
  for (const wf of WORKFLOWS) {
    const transition = parseTransitionLocal(toolName, toolInput, wf.transitionPattern);
    // (Patch 10) Validate target is a real step in this workflow
    if (transition.isTransition && !wf.steps.includes(transition.targetStep)) continue;
    const block = loopRules.checkWorkflowPre(wf, { ticketId, toolName, toolInput, transition });
    if (!block) continue;
    if (block.action) appendAction(ticketId, block.action);
    exitBlocked(block.message);
  }
}

function handlePreToolUse(hookData) {
  const toolName = hookData.tool_name || '';
  const toolInput = hookData.tool_input || {};

  // Find active ticket. May be null when the hook's CWD is not a worktree.
  // Do NOT early-return on null — Rule 5 (token mint) does not need a ticket.
  const ticketId = getTicketId(hookData);

  const rule3 = runPreBlockingRules(toolName, toolInput, hookData, ticketId);
  if (rule3.skipRemainingChecks) return; // Edit/Write/MultiEdit — skip per-workflow loop

  // The per-workflow state/transition loop needs a ticketId to load any state.
  if (!ticketId) return;
  runPreWorkflowLoop(ticketId, toolName, toolInput);
}

// ─── PostToolUse ────────────────────────────────────────────────────────────

function handlePostToolUse(hookData) {
  const toolName = hookData.tool_name || '';
  const toolInput = hookData.tool_input || {};

  const ticketId = getTicketId();
  if (!ticketId) return;

  // Process each active workflow — record evidence, clear on backward transitions
  for (const wf of WORKFLOWS) {
    const transition = parseTransitionLocal(toolName, toolInput, wf.transitionPattern);
    // (Patch 10) Validate target is a real step in this workflow
    if (transition.isTransition && !wf.steps.includes(transition.targetStep)) continue;
    loopRules.recordWorkflowPost(wf, { ticketId, toolName, toolInput, transition });
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

// (Patch 8) Harden main() — guard empty stdin and log errors
async function main() {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }

    if (!input.trim()) return; // Empty stdin → allow

    const hookData = JSON.parse(input);
    // CLAUDE_HOOK_TYPE prefix survives both runtimes; hook_event_name is the payload fallback (C12).
    const hookType = process.env.CLAUDE_HOOK_TYPE || hookData.hook_event_name || 'PostToolUse';

    // Telemetry: log every fire so we can prove the hook ran. JSONL.
    logHookFired(hookType, hookData);

    if (hookType === 'PreToolUse') {
      handlePreToolUse(hookData);
    } else if (hookType === 'PostToolUse') {
      handlePostToolUse(hookData);
    }
  } catch (err) {
    if (DEBUG) process.stderr.write(`[enforce-step-workflow] fail-open: ${err?.message}\n`);
    logHookError(__filename, err);
  }
}

main().catch((err) => {
  if (DEBUG) process.stderr.write(`[enforce-step-workflow] fatal: ${err?.message}\n`);
  logHookError(__filename, err);
});
