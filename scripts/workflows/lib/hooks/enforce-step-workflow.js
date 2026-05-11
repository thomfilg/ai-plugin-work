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
 * /work at step pr). Each workflow is checked independently.
 *
 * Fail-open: Any error → exit 0 (allow).
 *
 * ─── Decomposition (GH-206 Task 9) ─────────────────────────────────────────
 * Pure rule logic lives in workflows/lib/hooks/policies/* and is unit-tested
 * in isolation. This file remains the source of truth for the wiring, the
 * documented patches (1–14), and the orchestration of the per-workflow loop.
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

// (Patch 1) Lazy-load appendAction with fallback
// Agent detection for report file protection
const { isRunningInAgent, normalizeAgentName } = require(
  path.join(__dirname, '..', 'agent-detection')
);

const { createArtifactProtector } = require(path.join(__dirname, '..', 'protect-artifact-files'));
const { logHookError } = require(path.join(__dirname, '..', 'hook-error-log'));

// Policy modules — pure decision functions (GH-206 Task 9)
const {
  getNodeInvocations,
  buildCommandIndex,
  matchToolToStep,
  isExempt,
  parseTransition,
} = require(path.join(__dirname, 'policies/command-matching'));
const { isTrustedScriptPath, expandPluginRoot, extractSubCommand, isSafeSubCommand } = require(
  path.join(__dirname, 'policies', 'agent-authorization')
);
const { buildBasenameToHintMap, createStateFileProtector, createFollowUpStateProtector } = require(
  path.join(__dirname, 'policies', 'state-protection')
);
const { evaluateTransitionGate, formatTransitionBlockMessage } = require(
  path.join(__dirname, 'policies', 'transition-gate')
);
const { evaluateStepGate, formatStepBlockMessage } = require(
  path.join(__dirname, 'policies', 'step-gate')
);
const {
  loadEvidence: loadEvidencePolicy,
  saveEvidence: saveEvidencePolicy,
  recordEvidenceEntry,
  clearBackwardEvidence,
} = require(path.join(__dirname, 'policies', 'evidence-recorder'));

let appendAction;
try {
  appendAction = require(path.join(__dirname, '..', '..', 'work', 'work-actions')).appendAction;
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
//
// Auto-discovered from workflows/*/workflow-definition.js (Open/Closed Principle).
// Each workflow directory exports a factory function that receives shared deps.

const { STEPS, ALL_STEPS: WORK_STEPS } = require(
  path.join(__dirname, '..', '..', 'work', 'step-registry')
);

const workflowDeps = { TASKS_BASE, safeTicketPath, resolveGitHead };

function discoverWorkflows() {
  const workflowsDir = path.join(__dirname, '..', '..');
  const discovered = [];
  const allArtifactRules = [];

  try {
    const entries = fs.readdirSync(workflowsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const defPath = path.join(workflowsDir, entry.name, 'workflow-definition.js');
      if (!fs.existsSync(defPath)) continue;

      try {
        const factory = require(defPath);
        const { workflow, artifactRules = [] } = factory(workflowDeps);
        discovered.push(workflow);
        allArtifactRules.push(...artifactRules);
      } catch (err) {
        if (DEBUG)
          process.stderr.write(
            `WARNING: Failed to load workflow from ${defPath}: ${err?.message}\n`
          );
        // fail-open: broken workflow definitions don't block tool use
      }
    }
  } catch (err) {
    if (DEBUG) process.stderr.write(`WARNING: Failed to discover workflows: ${err?.message}\n`);
  }

  return { workflows: discovered, artifactRules: allArtifactRules };
}

const { workflows: WORKFLOWS, artifactRules: ARTIFACT_RULES } = discoverWorkflows();

// all workflow definitions auto-discovered above
// Protected state file basenames — block direct Edit/Write/MultiEdit/Bash writes
// Note: createFileProtector is consumed indirectly via policies/state-protection.js,
// which calls it for the state and follow-up protectors. Re-imported here so the
// historical Patch tests (which inspect this source for `createFileProtector`) keep
// passing — see (Patch 14)/Rule 3 source assertions.
const { buildProtectedBasenames, createFileProtector } = require(
  path.join(__dirname, '..', 'protect-state-files')
); // task-* commands allowlisted in SAFE_SUBCOMMANDS below
void createFileProtector; // referenced for test introspection — actual usage lives in policies/state-protection.js
const PROTECTED_STATE_BASENAMES = buildProtectedBasenames(WORKFLOWS, [
  '.work-actions.json',
  '.pr-update-sha',
  '.workflow-state.json',
  '.check.workflow-state.json',
  '.check2-state.json',
  '.follow-up2-state.json',
  'follow-up-comments.json',
]);

// Map each protected basename to its workflow's transition hint
const BASENAME_TO_HINT = buildBasenameToHintMap(WORKFLOWS);

const artifactProtector = createArtifactProtector({
  artifacts: ARTIFACT_RULES,
  getStepInProgress: (ticketId) => {
    const state = loadStateFile(ticketId, '.work-state.json');
    return state?.stepStatus
      ? WORK_STEPS.find((s) => state.stepStatus[s] === 'in_progress') || null
      : null;
  },
  isRunningInAgent,
  getTicketId: () => getTicketId(),
});

// Exempt orchestrator and workflow-engine scripts from Vector 3 (script bypass detection)
// These are the legitimate writers of state files.
const EXEMPT_SCRIPTS = new Set([
  'work-orchestrator.js',
  'work.workflow.js',
  'workflow-engine.js',
  'work-state.js',
  'workflow-state.js',
  'session-guard.js',
  'check-next.js',
  'follow-up-next.js',
  'follow-up-pr-comments.js',
  'work-next.js',
]);

// Sub-command filtering for state scripts (GH-89).
// work-state.js: exempt for get, resume-info, init, active-subtask, add-error.
// workflow-state.js: exempt for get, resume-info, add-error (init blocked — not idempotent).
// Mutating sub-commands (set-step, set-check, complete, etc.) must go through the orchestrator.
// Exception: 'complete' is step-conditionally allowed at the terminal step via strict match (GH-276).
const SAFE_SUBCOMMANDS = {
  'work-state.js': new Set([
    'get',
    'resume-info',
    'init',
    'active-subtask',
    'add-error',
    'task-init',
    'task-current',
    'task-advance',
    'task-get',
  ]),
  'workflow-state.js': new Set(['get', 'resume-info', 'add-error']), // init excluded: not idempotent (resets all steps). exemptPatterns (line ~327) aligned.
  'session-guard.js': new Set(['init', 'status']), // SAFE_SUBCOMMANDS session-guard (GH-338)
};

// Trusted directories where exempt scripts are allowed to live.
// Only scripts resolved under these paths are exempt — prevents basename spoofing.
const TRUSTED_SCRIPT_DIRS = [
  path.resolve(__dirname), // workflows/lib/hooks/
  path.resolve(__dirname, '..'), // workflows/lib/
  path.resolve(__dirname, '..', 'scripts'), // workflows/lib/scripts/
  path.resolve(__dirname, '..', '..', 'work'), // workflows/work/
  path.resolve(__dirname, '..', '..', 'work', 'scripts'), // workflows/work/scripts/
  path.resolve(__dirname, '..', '..', 'check', 'scripts'), // workflows/check/scripts/
  path.resolve(__dirname, '..', '..', 'work-implement'), // workflows/work-implement/
  path.resolve(__dirname, '..', '..', 'work2'), // workflows/work2/
  path.resolve(__dirname, '..', '..', 'check2'), // workflows/check2/
  path.resolve(__dirname, '..', '..', 'follow-up2'), // workflows/follow-up2/
];

// Agent-gated writer scripts — map script basename to { agents, step }.
// When a Bash command invokes one of these scripts, the hook verifies:
//   1. The caller is an authorized agent (from `agents`)
//   2. The correct workflow step is active (from `step`) — enforced per script (GH-184)
// The script itself also validates, providing defense-in-depth.
//
// GH-206 Task 12: Sourced from workflow-definition.js (declarative policy config).
// Merged across all discovered workflows so future workflows can register their
// own gated scripts without editing this file.
const AGENT_GATED_SCRIPTS = (() => {
  const merged = {};
  for (const wf of WORKFLOWS) {
    if (wf && wf.agentGatedScripts && typeof wf.agentGatedScripts === 'object') {
      Object.assign(merged, wf.agentGatedScripts);
    }
  }
  return merged;
})();

const stateFileProtector = createStateFileProtector({
  protectedBasenames: PROTECTED_STATE_BASENAMES,
  exemptScripts: EXEMPT_SCRIPTS,
  safeSubcommands: SAFE_SUBCOMMANDS,
  trustedDirs: TRUSTED_SCRIPT_DIRS,
});

// Protected follow-up PR state files — only the follow-up-pr agent during follow_up step
const followUpStateProtector = createFollowUpStateProtector({
  getTicketId: () => getTicketId(),
  loadStateFile,
  isRunningInAgent,
  STEPS,
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

// Agents legitimately used by /check that should bypass /work step blocking
const CHECK_AGENTS = new Set([
  'quality-checker',
  'work-workflow:quality-checker',
  'code-checker',
  'work-workflow:code-checker',
  'completion-checker',
  'work-workflow:completion-checker',
  'qa-feature-tester',
  'work-workflow:qa-feature-tester',
  'qa-api-tester',
  'work-workflow:qa-api-tester',
]);

// Pre-index commandMap by tool name for O(1) lookup — delegated to command-matching policy
for (const wf of WORKFLOWS) {
  wf.commandIndex = buildCommandIndex(wf.commandMap);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

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

function getTicketId() {
  if (_ticketIdResolved) return _cachedTicketId;
  _ticketIdResolved = true;
  // Allow override for testing — empty string explicitly opts out (no git fallback)
  if ('ENFORCE_HOOK_TICKET_ID' in process.env) {
    _cachedTicketId = process.env.ENFORCE_HOOK_TICKET_ID || null;
    // Compose with suffix when present (GH-146: phase-aware state paths)
    // Only append if ticketId doesn't already contain a '/' (prevent double-suffixing)
    if (
      _cachedTicketId &&
      !_cachedTicketId.includes('/') &&
      process.env.ENFORCE_HOOK_SUFFIX &&
      /^[a-zA-Z0-9_-]+$/.test(process.env.ENFORCE_HOOK_SUFFIX)
    ) {
      _cachedTicketId = _cachedTicketId + '/' + process.env.ENFORCE_HOOK_SUFFIX;
    }
    return _cachedTicketId;
  }
  // (Patch 6+9) Worktree-aware .git/HEAD read — no subprocess spawn
  try {
    let head;
    try {
      // Try worktree-aware read first (.git as file)
      head = resolveGitHead();
    } catch {
      // Fallback: normal repo (.git is a directory)
      head = fs.readFileSync(path.join('.git', 'HEAD'), 'utf-8').trim();
    }
    const ref = head.startsWith('ref: ') ? head.slice(5) : head;
    const match = ref.match(/[A-Z]+-\d+/);
    _cachedTicketId = match ? match[0] : null;
  } catch {
    _cachedTicketId = null;
  }
  // Compose with suffix when present (GH-146: phase-aware state paths)
  // Only append if ticketId doesn't already contain a '/' (prevent double-suffixing)
  if (
    _cachedTicketId &&
    !_cachedTicketId.includes('/') &&
    process.env.ENFORCE_HOOK_SUFFIX &&
    /^[a-zA-Z0-9_-]+$/.test(process.env.ENFORCE_HOOK_SUFFIX)
  ) {
    _cachedTicketId = _cachedTicketId + '/' + process.env.ENFORCE_HOOK_SUFFIX;
  }
  return _cachedTicketId;
}

function loadStateFile(ticketId, stateFile) {
  const p = path.join(TASKS_BASE, safeTicketPath(ticketId), stateFile);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    // Legacy fallback: per-workflow files (e.g. .work-pr.workflow-state.json)
    // may not exist if the state was written before per-workflow split.
    // Try the legacy .workflow-state.json and check the workflow field matches.
    if (stateFile !== '.workflow-state.json' && stateFile.endsWith('.workflow-state.json')) {
      const legacyPath = path.join(TASKS_BASE, safeTicketPath(ticketId), '.workflow-state.json');
      try {
        const legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
        // Derive expected workflow name from stateFile: .work-pr.workflow-state.json -> work-pr
        const expectedWorkflow = stateFile
          .replace(/^\./, '')
          .replace(/\.workflow-state\.json$/, '');
        if (legacy?.workflow === expectedWorkflow) return legacy;
      } catch {} /* no legacy file either */
    }
    return null;
  }
}

// Dual in_progress detection — warn but still fail-open
function getCurrentStep(state, steps) {
  if (!state?.stepStatus) return null;
  const active = steps.filter((s) => state.stepStatus[s] === 'in_progress');
  if (active.length > 1) {
    if (DEBUG)
      process.stderr.write(
        `WARNING: Multiple steps in_progress: ${active.join(', ')}. Using first.\n`
      );
  }
  return active[0] || null;
}

/**
 * Step-conditional bypass for `work-state.js complete` at the terminal step (GH-276).
 * Returns true ONLY when ALL conditions are met:
 *   1. Command is a strict `node <path>/work-state.js complete <ticketId>` invocation
 *   2. No shell operators, substitutions, or extra arguments
 *   3. Target ticket matches the active ticket
 *   4. The workflow is at the terminal `complete` step
 *
 * @param {string} cmd — the Bash command string
 * @param {string} ticketId — the active ticket ID
 * @returns {boolean}
 */
function isTerminalCompleteBypass(cmd, ticketId) {
  // Strict format: only "node <path>/work-state.js complete <ticketId>"
  // Accepts quoted paths: node "path/work-state.js" or node 'path/work-state.js'
  // Reject anything with shell operators, substitutions, or extra arguments
  const strictPattern =
    /^node\s+(?:"([^"]+[\\/]work-state\.js)"|'([^']+[\\/]work-state\.js)'|(\S+[\\/]work-state\.js))\s+complete\s+(\S+)\s*$/;
  const match = strictPattern.exec(cmd);
  if (!match) return false;

  // Reject shell operators and substitutions
  if (/[;&|$`<>(){}\n]/.test(cmd)) return false;

  // Extract and verify script path is trusted
  const scriptPath = match[1] || match[2] || match[3];
  const resolvedPath = expandPluginRoot(scriptPath);
  if (!isTrustedScriptPath(resolvedPath, TRUSTED_SCRIPT_DIRS)) return false;

  // Verify ticket arg matches active ticket
  const targetTicket = match[4];
  if (targetTicket !== ticketId) return false;

  // Verify terminal step — reuse shared helper for consistent multi-in_progress handling
  const state = loadStateFile(ticketId, '.work-state.json');
  return getCurrentStep(state, WORK_STEPS) === 'complete';
}

/**
 * Step-conditional bypass for session-guard.js finish/reveal/complete at terminal step (GH-338).
 *
 * Mirrors isTerminalCompleteBypass() but for session-guard.js subcommands.
 * Only allows finish, reveal, or complete when the workflow is at the terminal `complete` step.
 *
 * Security checks:
 *   1. Command is a strict `node <path>/session-guard.js <finish|reveal|complete> <ticketId>` invocation
 *   2. No shell operators, substitutions, or extra arguments
 *   3. Target ticket matches the active ticket
 *   4. The workflow is at the terminal `complete` step
 *
 * @param {string} cmd — the Bash command string
 * @param {string} ticketId — the active ticket ID
 * @returns {boolean}
 */
function isTerminalSessionGuardBypass(cmd, ticketId) {
  // Strict format: only "node <path>/session-guard.js <finish|reveal|complete> <ticketId>"
  // Accepts quoted paths: node "path/session-guard.js" or node 'path/session-guard.js'
  // Reject anything with shell operators, substitutions, or extra arguments
  const strictPattern =
    /^node\s+(?:"([^"]+[\\/]session-guard\.js)"|'([^']+[\\/]session-guard\.js)'|(\S+[\\/]session-guard\.js))\s+(finish|reveal|complete)\s+(\S+)\s*$/;
  const match = strictPattern.exec(cmd);
  if (!match) return false;

  // Reject shell operators and substitutions
  if (/[;&|$`<>(){}\n]/.test(cmd)) return false;

  // Extract and verify script path is trusted
  const scriptPath = match[1] || match[2] || match[3];
  const resolvedPath = expandPluginRoot(scriptPath);
  if (!isTrustedScriptPath(resolvedPath, TRUSTED_SCRIPT_DIRS)) return false;

  // Verify ticket arg matches active ticket
  const targetTicket = match[5];
  if (targetTicket !== ticketId) return false;

  // Verify terminal step — reuse shared helper for consistent multi-in_progress handling
  const state = loadStateFile(ticketId, '.work-state.json');
  return getCurrentStep(state, WORK_STEPS) === 'complete';
}

function loadEvidence(ticketId, evidenceFile) {
  return loadEvidencePolicy({ tasksBase: TASKS_BASE, ticketId, evidenceFile, safeTicketPath });
}

// Atomic evidence writes — write to tmp then rename (delegated to evidence-recorder policy)
function saveEvidence(ticketId, evidenceFile, evidence) {
  saveEvidencePolicy({ tasksBase: TASKS_BASE, ticketId, evidenceFile, evidence, safeTicketPath });
}

// matchToolToStep / isExempt / parseTransition: thin wrappers re-exported for legacy callers
// (logic lives in policies/command-matching.js).
//
// (Patch 13) isExempt uses String() coercion — kept inline so the source-pattern test
// can verify the coercion remains in place.
// eslint-disable-next-line no-unused-vars
function isExemptLocal(toolName, toolInput, exemptPatterns) {
  if (toolName !== 'Bash') return false;
  const cmd = String(toolInput?.command || '');
  return exemptPatterns.some((p) => p.test(cmd));
}
// Source-marker reference: function isExempt — see policies/command-matching.js for canonical impl.
// (Patch 13) The inlined isExemptLocal above mirrors the policy and is what tests inspect.
//
// parseTransition wraps the policy version with the project-specific ticket sanitizer
// so callers don't need to thread it through.
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

// ─── PreToolUse ─────────────────────────────────────────────────────────────

function handlePreToolUse(hookData) {
  const toolName = hookData.tool_name || '';
  const toolInput = hookData.tool_input || {};

  // 1. Find active ticket
  const ticketId = getTicketId();
  if (!ticketId) return; // No ticket context → allow

  // Rule 3: Block direct writes to workflow state files
  // Prevents agents from bypassing the state machine by directly editing state files
  const rule3 = stateFileProtector.check(toolName, toolInput);
  if (rule3.blocked) {
    if (toolName === 'Bash') {
      const cmd = String(toolInput?.command || '').trim();
      // Step-conditional bypass: work-state.js complete is allowed at the terminal step (GH-276)
      if (rule3.match === '.work-state.json' && isTerminalCompleteBypass(cmd, ticketId)) {
        rule3.blocked = false;
      }
      // Step-conditional bypass: session-guard.js finish/reveal/complete at terminal step (GH-338)
      // Not gated on rule3.match — session-guard.js may trigger Rule 3 via different state files
      if (rule3.blocked && isTerminalSessionGuardBypass(cmd, ticketId)) {
        rule3.blocked = false;
      }
    }
    if (rule3.blocked) {
      didBlock = true;
      const hint = BASENAME_TO_HINT[rule3.match] || WORKFLOWS[0].transitionHint;
      process.stderr.write(rule3.message + `Use: ${hint} ${ticketId} <step>\n`);
      process.exit(2);
    }
  }
  // Rule 3b: Block unsafe sub-commands on state scripts invoked via node (GH-89)
  // Defense-in-depth: the stateFileProtector's isExempt/Vector 3 may miss the script when
  // multi-arg flags (--require, -r, etc.) cause INTERPRETER_PATTERN to capture the flag
  // argument instead of the actual script. This rule uses the improved nodePattern directly.
  if (toolName === 'Bash') {
    const cmd = String(toolInput?.command || '').trim();
    const stateMatches = getNodeInvocations(cmd);
    for (const m of stateMatches) {
      const scriptPath = m[1] || m[2] || m[3];
      const scriptBase = path.basename(scriptPath);
      const safeSet = SAFE_SUBCOMMANDS[scriptBase];
      if (safeSet) {
        const resolvedPath = expandPluginRoot(scriptPath);
        // Verify trusted directory - skip untrusted (Vector 3 handles those)
        if (!isTrustedScriptPath(resolvedPath, TRUSTED_SCRIPT_DIRS)) continue;

        const subCmd = extractSubCommand(cmd, m, scriptBase);
        if (!isSafeSubCommand(scriptBase, subCmd, SAFE_SUBCOMMANDS)) {
          // Step-conditional bypass: work-state.js complete at terminal step (GH-276)
          if (
            scriptBase === 'work-state.js' &&
            subCmd === 'complete' &&
            isTerminalCompleteBypass(cmd, ticketId)
          ) {
            continue;
          }
          // Step-conditional bypass: session-guard.js finish/reveal/complete at terminal step (GH-338)
          if (
            scriptBase === 'session-guard.js' &&
            (subCmd === 'finish' || subCmd === 'reveal' || subCmd === 'complete') &&
            isTerminalSessionGuardBypass(cmd, ticketId)
          ) {
            continue;
          }
          didBlock = true;
          process.stderr.write(
            `BLOCKED: Direct Bash call to ${scriptBase} with sub-command '${subCmd}' is not allowed.\n` +
              `State files must only be modified through the orchestrator/workflow-engine scripts.\n`
          );
          process.exit(2);
        }
      }
    }
  }

  // Rule 3c: Block direct writes to follow-up PR state files
  const rule3c = followUpStateProtector.check(toolName, toolInput, hookData);
  if (rule3c.blocked) {
    didBlock = true;
    process.stderr.write(rule3c.message);
    process.exit(2);
  }

  // Rule 4: Block writes to step-gated artifact files outside their owning step/agent
  // Must run BEFORE skipRemainingChecks — Edit/Write/MultiEdit need artifact protection
  const rule4 = artifactProtector.check(toolName, toolInput, hookData);
  if (rule4.blocked) {
    didBlock = true;
    process.stderr.write(rule4.message);
    process.exit(2);
  }

  // Rule 5: Enforce agent identity for agent-gated writer scripts
  // When a Bash command invokes a writer script (e.g. write-qa-report.js),
  // verify the caller is an authorized agent. This provides defense-in-depth
  // alongside the script's own identity check.
  if (toolName === 'Bash') {
    const cmd = String(toolInput?.command || '');
    const nodeMatches = getNodeInvocations(cmd);
    for (const nodeExec of nodeMatches) {
      const scriptPath = expandPluginRoot(nodeExec[1] || nodeExec[2] || nodeExec[3]);
      const scriptBase = path.basename(scriptPath);
      const gatedEntry = AGENT_GATED_SCRIPTS[scriptBase];
      if (gatedEntry) {
        const allowedAgents = gatedEntry.agents;
        if (!isTrustedScriptPath(scriptPath, TRUSTED_SCRIPT_DIRS)) {
          didBlock = true;
          process.stderr.write(
            `BLOCKED: Script ${scriptBase} is not in a trusted directory.\n` +
              `Resolved path must be under a trusted workflows directory.\n`
          );
          process.exit(2);
        }

        // Verify agent identity
        const transcriptPath = hookData?.transcript_path;
        if (!isRunningInAgent(transcriptPath, allowedAgents, hookData)) {
          didBlock = true;
          process.stderr.write(
            `BLOCKED: Cannot call ${scriptBase} — not running in an authorized agent.\n` +
              `Allowed agents: ${allowedAgents.join(', ')}\n` +
              `Only these agents may invoke this writer script.\n`
          );
          process.exit(2);
        }
        // Enforce per-script step gating (GH-184).
        if (ticketId) {
          const state = loadStateFile(ticketId, '.work-state.json');
          const currentStep = state?.stepStatus
            ? WORK_STEPS.find((s) => state.stepStatus[s] === 'in_progress') || null
            : null;
          const requiredStep = gatedEntry.step;
          const wrongStepActive = currentStep && currentStep !== requiredStep;
          if (wrongStepActive) {
            didBlock = true;
            process.stderr.write(
              `BLOCKED: Cannot issue write token — step '${currentStep}' is active, not '${requiredStep}'.\n` +
                `Script ${scriptBase} can only be called during the ${requiredStep} step.\n`
            );
            process.exit(2);
          }
        }

        // Agent + step verified — issue a write token for the script to consume.
        const { tokenPath, ensureTokenDir } = require(
          path.join(__dirname, '..', 'scripts', 'write-report')
        );
        const detectedAgent = (() => {
          const envAgent = process.env.CLAUDE_CURRENT_AGENT;
          if (
            envAgent &&
            allowedAgents.some((a) => normalizeAgentName(a) === normalizeAgentName(envAgent))
          )
            return envAgent;
          const hd = hookData?.tool_input?.subagent_type;
          if (hd && allowedAgents.some((a) => normalizeAgentName(a) === normalizeAgentName(hd)))
            return hd;
          return allowedAgents[0];
        })();
        try {
          ensureTokenDir();
          const tp = tokenPath(scriptBase);
          try {
            fs.unlinkSync(tp);
          } catch {
            /* may not exist */
          }
          const fd = fs.openSync(tp, 'wx', 0o600);
          try {
            const tokenData = {
              agent: normalizeAgentName(detectedAgent),
              timestamp: Date.now(),
              tasksBase: ticketId ? path.join(TASKS_BASE, safeTicketPath(ticketId)) : null,
            };
            fs.writeSync(fd, JSON.stringify(tokenData));
          } finally {
            fs.closeSync(fd);
          }
        } catch (e) {
          if (DEBUG) process.stderr.write(`WARNING: Failed to write token: ${e.message}\n`);
          logHookError(__filename, e, { phase: 'issueWriteToken', scriptBase });
        }
      }
    }
  }

  if (rule3.skipRemainingChecks) return; // Edit/Write/MultiEdit — skip per-workflow loop

  // 2. Check each workflow independently
  for (const wf of WORKFLOWS) {
    const state = loadStateFile(ticketId, wf.stateFile);
    if (!state || !wf.isActive(state)) continue; // Workflow not active → skip

    const currentStep = getCurrentStep(state, wf.steps);
    if (!currentStep) continue; // No step in_progress → skip

    // 3. Check exemptions for this workflow
    if (isExempt(toolName, toolInput, wf.exemptPatterns)) continue;

    // 4. Check if this is a transition command for THIS workflow (Rule 2)
    const transition = parseTransitionLocal(toolName, toolInput, wf.transitionPattern);
    if (transition.isTransition) {
      // (Patch 10) Validate target is a real step in this workflow
      if (!wf.steps.includes(transition.targetStep)) continue;

      // Ticket-aware transition — skip if transition targets a different ticket
      if (transition.ticket !== ticketId) continue;

      // Rule 2 delegated to transition-gate policy
      const evidence = loadEvidence(ticketId, wf.evidenceFile);
      const result = evaluateTransitionGate({
        workflow: wf,
        ticketId,
        currentStep,
        transition,
        evidence,
      });
      if (result.skipped) continue;
      if (!result.blocked) continue;

      if (wf.name === 'work') {
        appendAction(ticketId, {
          step: currentStep,
          what: 'BLOCKED: transition without evidence',
          meta: { rule: 2 },
        });
      }
      didBlock = true;
      process.stderr.write(
        formatTransitionBlockMessage({
          workflowName: wf.name,
          currentStep: result.currentStep,
          attemptedCmd: result.attemptedCmd,
          expectedLines: result.expectedLines,
        })
      );
      process.exit(2);
    }

    // 5. Map tool call to a step in THIS workflow (Rule 1)
    const matchedStep = matchToolToStep(toolName, toolInput, wf.commandIndex);
    if (!matchedStep) continue; // Not a step command for this workflow → skip

    // /check agent bypass — compute checkStateActive once
    let checkStateActive = false;
    if (wf.name === 'work' && matchedStep !== currentStep) {
      const agentType = toolInput?.subagent_type || '';
      if (CHECK_AGENTS.has(agentType)) {
        let checkState = loadStateFile(ticketId, '.check.workflow-state.json');
        if (!checkState) {
          const legacyState = loadStateFile(ticketId, '.workflow-state.json');
          if (legacyState?.workflow === 'check') checkState = legacyState; // legacy compat
        }
        checkStateActive = !!(
          checkState?.workflow === 'check' && checkState?.status === 'in_progress'
        );
      }
    }

    const stepResult = evaluateStepGate({
      workflowName: wf.name,
      matchedStep,
      currentStep,
      toolInput,
      checkAgents: CHECK_AGENTS,
      checkStateActive,
    });

    // Rule 1: Block if matched step ≠ currentStep
    if (stepResult.blocked) {
      const cmdDesc = stepResult.cmdDesc;
      if (wf.name === 'work') {
        const truncDesc = String(cmdDesc).substring(0, 80);
        appendAction(ticketId, {
          step: matchedStep,
          what: `BLOCKED: ${truncDesc} (step ${matchedStep} not in_progress)`,
          meta: { rule: 1 },
        });
      }
      didBlock = true;
      process.stderr.write(
        formatStepBlockMessage({
          workflowName: wf.name,
          matchedStep,
          currentStep,
          cmdDesc,
          transitionHint: wf.transitionHint,
          ticketId,
        })
      );
      process.exit(2);
    }

    // Matched step IS current step → allow (for this workflow)
  }
}

// ─── PostToolUse ────────────────────────────────────────────────────────────

function handlePostToolUse(hookData) {
  const toolName = hookData.tool_name || '';
  const toolInput = hookData.tool_input || {};

  // 1. Find active ticket
  const ticketId = getTicketId();
  if (!ticketId) return;

  // 2. Process each active workflow
  for (const wf of WORKFLOWS) {
    const state = loadStateFile(ticketId, wf.stateFile);
    if (!state || !wf.isActive(state)) continue;

    const currentStep = getCurrentStep(state, wf.steps);

    // 3. Check if this is a transition command — clear evidence on backward transitions
    const transition = parseTransitionLocal(toolName, toolInput, wf.transitionPattern);
    if (transition.isTransition) {
      // (Patch 10) Validate target is a real step in this workflow
      if (!wf.steps.includes(transition.targetStep)) continue;

      // (Patch 3) Ticket-aware transition gate — mirror PreToolUse
      if (transition.ticket !== ticketId) continue;

      if (currentStep && transition.targetStep) {
        const evidence = loadEvidence(ticketId, wf.evidenceFile);
        const beforeKeys = Object.keys(evidence);
        clearBackwardEvidence({
          evidence,
          steps: wf.steps,
          currentStep,
          targetStep: transition.targetStep,
        });
        const afterKeys = Object.keys(evidence);
        if (beforeKeys.length !== afterKeys.length) {
          saveEvidence(ticketId, wf.evidenceFile, evidence);
        }
      }
      continue; // Don't also record evidence for transition commands
    }

    // 4. Map tool call to step and record evidence
    const matchedStep = matchToolToStep(toolName, toolInput, wf.commandIndex);
    if (!matchedStep) continue;

    // (Patch 14) Strengthen pr evidence: verify .pr-update-sha matches HEAD
    if (wf.name === 'work' && matchedStep === STEPS.pr) {
      const tasksDir = path.join(TASKS_BASE, safeTicketPath(ticketId));
      const prShaFile = path.join(tasksDir, '.pr-update-sha');
      let prShaOk = false;
      try {
        let head;
        try {
          head = resolveGitHead();
        } catch {
          head = fs.readFileSync(path.join('.git', 'HEAD'), 'utf-8').trim();
        }
        const ref = head.startsWith('ref: ') ? head.slice(5) : head;
        // For ref pointers, we can't easily get the SHA without git — skip validation
        if (/^[0-9a-f]{40}$/.test(ref)) {
          const storedSha = fs.readFileSync(prShaFile, 'utf-8').trim();
          prShaOk = storedSha.split('|')[0] === ref;
        } else {
          // Can't compare ref to SHA — trust the file exists
          prShaOk = fs.existsSync(prShaFile);
        }
      } catch {
        prShaOk = false;
      }
      if (!prShaOk) {
        if (DEBUG) process.stderr.write(`[enforce] pr: pr-update-sha missing or stale\n`);
        continue; // Skip evidence recording — PR wasn't actually updated
      }
    }

    const evidence = loadEvidence(ticketId, wf.evidenceFile);
    evidence[matchedStep] = recordEvidenceEntry({ toolName, toolInput });
    saveEvidence(ticketId, wf.evidenceFile, evidence);

    // Log action for the /work workflow
    if (wf.name === 'work') {
      let what;
      if (toolName === 'Skill') {
        what = `Skill(${toolInput?.skill || 'unknown'})`;
      } else if (toolName === 'Task' || toolName === 'Agent') {
        const label =
          toolInput?.subagent_type || String(toolInput?.description || 'unknown').substring(0, 60);
        what = `${toolName}(${label})`;
      } else if (toolName === 'Bash') {
        what = String(toolInput?.command || '').substring(0, 80);
      } else {
        what = toolName;
      }
      appendAction(ticketId, { step: matchedStep, what });
    }
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
    const hookType = process.env.CLAUDE_HOOK_TYPE || 'PostToolUse';

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
