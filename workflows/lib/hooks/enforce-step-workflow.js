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
const { isRunningInAgent, normalizeAgentName } = require(path.join(__dirname, '..', 'agent-detection'));

const { createArtifactProtector } = require(path.join(__dirname, '..', 'protect-artifact-files'));

let appendAction;
try {
  appendAction = require(path.join(__dirname, '..', '..', 'work', 'work-actions')).appendAction;
} catch {
  appendAction = () => {};
}

// ─── Configuration ──────────────────────────────────────────────────────────

const getConfig = require(path.join(__dirname, '..', 'get-config'));
const TASKS_BASE = getConfig('TASKS_BASE') || (() => {
  const wb = getConfig.orExit('WORKTREES_BASE'); // only required if TASKS_BASE isn't set
  return path.join(wb, 'tasks');
})();

function safeTicketPath(ticketId) {
  try { return require(path.join(__dirname, '..', 'config')).safeTicketId(ticketId); }
  catch { return ticketId; }
}

// ─── Workflow Definitions ───────────────────────────────────────────────────
//
// Auto-discovered from workflows/*/workflow-definition.js (Open/Closed Principle).
// Each workflow directory exports a factory function that receives shared deps.

const { STEPS, ALL_STEPS: WORK_STEPS } = require(path.join(__dirname, '..', '..', 'work', 'step-registry'));

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
        if (DEBUG) process.stderr.write(`WARNING: Failed to load workflow from ${defPath}: ${err?.message}\n`);
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
const { buildProtectedBasenames, basenameProtector, createFileProtector } = require(path.join(__dirname, '..', 'protect-state-files')); // task-* commands allowlisted in SAFE_SUBCOMMANDS below
const PROTECTED_STATE_BASENAMES = buildProtectedBasenames(WORKFLOWS, ['.work-actions.json', '.pr-update-sha', '.workflow-state.json', '.check.workflow-state.json']);

// Map each protected basename to its workflow's transition hint
const BASENAME_TO_HINT = {};
for (const wf of WORKFLOWS) {
  for (const bn of [path.basename(wf.stateFile), path.basename(wf.evidenceFile)]) {
    BASENAME_TO_HINT[bn] = wf.transitionHint;
  }
}

const artifactProtector = createArtifactProtector({
  artifacts: ARTIFACT_RULES,
  getStepInProgress: (ticketId) => {
    const state = loadStateFile(ticketId, '.work-state.json');
    return state?.stepStatus
      ? WORK_STEPS.find(s => state.stepStatus[s] === 'in_progress') || null
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
]);

// Sub-command filtering for state scripts (GH-89).
// work-state.js: exempt for get, resume-info, init, active-subtask, add-error.
// workflow-state.js: exempt for get, resume-info, add-error (init blocked — not idempotent).
// Mutating sub-commands (set-step, set-check, complete, etc.) must go through the orchestrator.
const SAFE_SUBCOMMANDS = {
  'work-state.js': new Set(['get', 'resume-info', 'init', 'active-subtask', 'add-error', 'task-init', 'task-current', 'task-advance', 'task-get']),
  'workflow-state.js': new Set(['get', 'resume-info', 'add-error']), // init excluded: not idempotent (resets all steps). exemptPatterns (line ~327) aligned.
};

// Trusted directories where exempt scripts are allowed to live.
// Only scripts resolved under these paths are exempt — prevents basename spoofing.
const TRUSTED_SCRIPT_DIRS = [
  path.resolve(__dirname),                           // workflows/lib/hooks/
  path.resolve(__dirname, '..'),                     // workflows/lib/
  path.resolve(__dirname, '..', 'scripts'),          // workflows/lib/scripts/
  path.resolve(__dirname, '..', '..', 'work'),       // workflows/work/
  path.resolve(__dirname, '..', '..', 'check', 'scripts'), // workflows/check/scripts/
  path.resolve(__dirname, '..', '..', 'work-implement'),   // workflows/work-implement/
];

// Shared regex source for detecting node script invocations in Bash commands (GH-89).
// Handles: cd && node ..., env prefixes, Node flags (including multi-arg like --require <path>),
// quoted paths. --eval/--print/-e/-p excluded (inline code, not file paths).
// Use getNodeInvocations() helper to catch ALL invocations in chained commands.
const NODE_INVOKE_PATTERN_SRC =
  '(?:^|&&|;|\\|)\\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|\'[^\']*\'|\\S+)\\s+)*(?:node|nodejs)\\s+(?:(?:--(?:require|loader|experimental-loader|import|input-type|conditions|inspect-brk|inspect|inspect-port)|-[rCi])\\s+\\S+\\s+|(?:-[^\\s]+\\s+))*(?:"([^"]+)"|\'([^\']+)\'|(\\S+))';

/** Return all node-script invocations from a command string. */
function getNodeInvocations(cmd) {
  return [...cmd.matchAll(new RegExp(NODE_INVOKE_PATTERN_SRC, 'g'))];
}

// Agent-gated writer scripts — map script basename to { agents, step }.
// When a Bash command invokes one of these scripts, the hook verifies:
//   1. The caller is an authorized agent (from `agents`)
//   2. The correct workflow step is active (from `step`) — enforced per script (GH-184)
// The script itself also validates, providing defense-in-depth.
const AGENT_GATED_SCRIPTS = {
  'write-qa-report.js':         { agents: ['qa-feature-tester', 'qa-api-tester'], step: STEPS.check },
  'write-tests-report.js':      { agents: ['quality-checker'], step: STEPS.check },
  'write-code-review.js':       { agents: ['code-checker'], step: STEPS.check },
  'write-completion-report.js':  { agents: ['completion-checker'], step: STEPS.check },
  'tdd-phase-state.js':         { agents: ['developer-nodejs-tdd', 'developer-react-senior', 'developer-react-ui-architect', 'developer-devops'], step: STEPS.implement },
};

const stateFileProtector = createFileProtector({
  isProtected: basenameProtector(PROTECTED_STATE_BASENAMES),
  isExempt: (toolName, toolInput) => {
    if (toolName !== 'Bash') return false;
    const cmd = String(toolInput?.command || '').trim();
    if (!cmd) return false;

    // Never exempt commands that directly target a protected basename.
    // This prevents bypass via: echo "work-orchestrator.js" > .work-state.json
    for (const bn of PROTECTED_STATE_BASENAMES) {
      if (cmd.includes(bn)) return false;
    }

    // Only exempt actual execution of exempt scripts via Node.
    // Handles: cd ... && node ..., env prefixes, Node flags, quoted paths
    // Not anchored to ^ so it matches node anywhere in a chained command
    const matches = getNodeInvocations(cmd);
    if (matches.length === 0) return false; // no node invocations found

    // Every node invocation must be exempt — one unsafe call blocks the whole command (GH-89).
    // AGENT_GATED_SCRIPTS (Rule 5) also uses matchAll for chained-command safety.
    for (const nodeMatch of matches) { // check every node invocation
      const scriptPath = nodeMatch[1] || nodeMatch[2] || nodeMatch[3];
      const scriptBase = path.basename(scriptPath);
      if (!EXEMPT_SCRIPTS.has(scriptBase)) return false;

      // Verify the script lives in a trusted directory (prevents basename spoofing)
      // Use realpathSync to resolve symlinks — a symlink under a trusted dir pointing outside is denied
      let trusted = false;
      try {
        const resolved = fs.realpathSync(path.resolve(scriptPath));
        trusted = TRUSTED_SCRIPT_DIRS.some(dir => resolved.startsWith(dir + path.sep));
      } catch { /* realpathSync failed (file doesn't exist) — deny */ }
      if (!trusted) return false;

      // Sub-command filtering (GH-89): for state scripts, only allow safe sub-commands
      const safeSet = SAFE_SUBCOMMANDS[scriptBase];
      if (safeSet) {
        // Extract args after the script path from the command segment
        const afterScript = cmd.slice(nodeMatch.index + nodeMatch[0].length).trim();
        const args = afterScript.split(/\s+/).filter(a => a && !a.startsWith('-'));
        // For workflow-state.js the sub-command is the 2nd arg (1st is workflow name)
        const subCmdIndex = scriptBase === 'workflow-state.js' ? 1 : 0;
        const rawSubCmd = args[subCmdIndex] || '';
        const subCmd = rawSubCmd.replace(/^['"]|['"]$/g, '');
        if (!safeSet.has(subCmd)) return false;
      }
    }

    return true; // All invocations passed exempt + trusted + sub-command checks
  },
  formatMessage: (match, vector) =>
    `BLOCKED: Direct ${vector} to ${match} is not allowed.\n` +
    `State files must only be modified through the orchestrator/workflow-engine scripts.\n`,
});

// Protected follow-up PR state files — only the follow-up-pr agent during follow_up step
const followUpStateProtector = createFileProtector({
  isProtected: (filePath) => {
    const bn = path.basename(filePath);
    return /^follow-up-pr-.+\.json$/.test(bn) ? bn : null;
  },
  isExempt: (_toolName, _toolInput, hookData) => {
    try {
      const ticketId = getTicketId();
      if (!ticketId) return true; // fail-open: no ticket context means not in a work workflow
      const state = loadStateFile(ticketId, '.work-state.json');
      if (!state?.stepStatus) return true; // fail-open: no active work workflow
      const stepInProgress = state.stepStatus[STEPS.follow_up] === 'in_progress';
      if (!stepInProgress) return false;
      return isRunningInAgent(hookData?.transcript_path, ['follow-up-pr'], hookData); // Note: review-accountability.json is protected separately by Rule 4 (ARTIFACT_RULES)
    } catch {
      return true; // fail-open
    }
  },
  formatMessage: (match, vector) =>
    `BLOCKED: Direct ${vector} to ${match} is not allowed.\n` +
    `Follow-up PR state files can only be written by the follow-up-pr agent during the follow_up step.\n`,
});

// (Patch 7) Validate workflow config at startup
function validateWorkflow(wf) {
  const stepSet = new Set(wf.steps);

  for (const s of wf.softSteps) {
    if (!stepSet.has(s)) throw new Error(`[${wf.name}] softSteps references unknown step: ${s}`);
  }

  for (const m of wf.commandMap) {
    if (!stepSet.has(m.step)) throw new Error(`[${wf.name}] commandMap references unknown step: ${m.step}`);
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
  'quality-checker', 'work-workflow:quality-checker',
  'code-checker', 'work-workflow:code-checker',
  'completion-checker', 'work-workflow:completion-checker',
  'qa-feature-tester', 'work-workflow:qa-feature-tester',
  'qa-api-tester', 'work-workflow:qa-api-tester',
]);

// Pre-index commandMap by tool name for O(1) lookup
function buildCommandIndex(commandMap) {
  const index = {};
  for (const mapping of commandMap) {
    if (!mapping.tool) continue; // Skip verify-only entries (no tool to match)
    const tools = Array.isArray(mapping.tool) ? mapping.tool : [mapping.tool];
    for (const tool of tools) {
      if (!index[tool]) index[tool] = [];
      index[tool].push(mapping);
    }
  }
  return index;
}

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
    if (_cachedTicketId && !_cachedTicketId.includes('/') && process.env.ENFORCE_HOOK_SUFFIX && /^[a-zA-Z0-9_-]+$/.test(process.env.ENFORCE_HOOK_SUFFIX)) {
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
  if (_cachedTicketId && !_cachedTicketId.includes('/') && process.env.ENFORCE_HOOK_SUFFIX && /^[a-zA-Z0-9_-]+$/.test(process.env.ENFORCE_HOOK_SUFFIX)) {
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
        const expectedWorkflow = stateFile.replace(/^\./, '').replace(/\.workflow-state\.json$/, '');
        if (legacy?.workflow === expectedWorkflow) return legacy;
      } catch {} /* no legacy file either */
    }
    return null;
  }
}

// Dual in_progress detection — warn but still fail-open
function getCurrentStep(state, steps) {
  if (!state?.stepStatus) return null;
  const active = steps.filter(s => state.stepStatus[s] === 'in_progress');
  if (active.length > 1) {
    if (DEBUG) process.stderr.write(`WARNING: Multiple steps in_progress: ${active.join(', ')}. Using first.\n`);
  }
  return active[0] || null;
}

function loadEvidence(ticketId, evidenceFile) {
  const p = path.join(TASKS_BASE, safeTicketPath(ticketId), evidenceFile);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

// Atomic evidence writes — write to tmp then rename
function saveEvidence(ticketId, evidenceFile, evidence) {
  const dir = path.join(TASKS_BASE, safeTicketPath(ticketId));
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, evidenceFile);
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(evidence, null, 2));
  fs.renameSync(tmp, target);
}

/**
 * Match a tool call to a workflow step using the pre-indexed command map.
 * Returns the step name or null if no match.
 */
function matchToolToStep(toolName, toolInput, commandIndex) {
  const mappings = commandIndex[toolName];
  if (!mappings) return null;

  for (const mapping of mappings) {
    // Tool-only match (no field pattern needed)
    if (mapping.field === null) return mapping.step;

    // Safer field coercion — handle non-string values
    const raw = toolInput?.[mapping.field];
    const value = typeof raw === 'string' ? raw : (raw == null ? '' : JSON.stringify(raw));
    if (mapping.pattern && mapping.pattern.test(value)) return mapping.step;
  }
  return null;
}

/**
 * Check if a Bash command is exempted for a specific workflow.
 */
function isExempt(toolName, toolInput, exemptPatterns) {
  if (toolName !== 'Bash') return false;
  // (Patch 13) Consistent String() coercion
  const cmd = String(toolInput?.command || '');
  return exemptPatterns.some(p => p.test(cmd));
}

/**
 * Parse a transition command for a specific workflow.
 * Returns { isTransition: true, ticket, targetStep, raw } or { isTransition: false }.
 */
function parseTransition(toolName, toolInput, transitionPattern) {
  if (toolName !== 'Bash') return { isTransition: false };
  // (Patch 4) Coerce command to string
  const cmd = String(toolInput?.command || '');
  const match = cmd.match(transitionPattern);
  if (match) {
    // Sanitize ticket ID so #NNN matches GH-NNN from branch (GH-168/GH-174)
    const tp = require(path.join(__dirname, '..', 'ticket-provider'));
    const providerConfig = tp.getProviderConfig({ skipPrompt: true });
    const safeTicket = tp.sanitizeTicketIdForPath(match[1], providerConfig);
    return { isTransition: true, ticket: safeTicket, targetStep: match[2], raw: cmd };
  }
  return { isTransition: false };
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
    didBlock = true;
    const hint = BASENAME_TO_HINT[rule3.match] || WORKFLOWS[0].transitionHint;
    process.stderr.write(
      rule3.message +
      `Use: ${hint} ${ticketId} <step>\n`
    );
    process.exit(2);
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
        // Expand $CLAUDE_PLUGIN_ROOT which is not resolved in hook context
        let resolvedPath = scriptPath;
        if (process.env.CLAUDE_PLUGIN_ROOT) {
          resolvedPath = resolvedPath
            .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, process.env.CLAUDE_PLUGIN_ROOT)
            .replace(/\$CLAUDE_PLUGIN_ROOT/g, process.env.CLAUDE_PLUGIN_ROOT);
        }
        // Verify trusted directory - skip untrusted (Vector 3 handles those)
        let trusted = false;
        try {
          const resolved = fs.realpathSync(path.resolve(resolvedPath));
          trusted = TRUSTED_SCRIPT_DIRS.some(dir => resolved.startsWith(dir + path.sep));
        } catch { /* realpathSync failed - untrusted */ }
        if (!trusted) continue; // basename match but untrusted path - Vector 3 will block

        const afterScript = cmd.slice(m.index + m[0].length).trim();
        const args = afterScript.split(/\s+/).filter(a => a && !a.startsWith('-'));
        const subCmdIndex = scriptBase === 'workflow-state.js' ? 1 : 0;
        const rawSubCmd = args[subCmdIndex] || '';
        const subCmd = rawSubCmd.replace(/^['"]|['"]$/g, '');
        if (!safeSet.has(subCmd)) {
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
    // Reuse the same robust nodePattern as exempt script detection (handles env prefixes, flags, quotes)
    const nodeMatches = getNodeInvocations(cmd);
    for (const nodeExec of nodeMatches) {
      let scriptPath = nodeExec[1] || nodeExec[2] || nodeExec[3];
      // Expand common shell variables that won't be expanded in hook context
      if (process.env.CLAUDE_PLUGIN_ROOT) {
        scriptPath = scriptPath
          .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, process.env.CLAUDE_PLUGIN_ROOT)
          .replace(/\$CLAUDE_PLUGIN_ROOT/g, process.env.CLAUDE_PLUGIN_ROOT);
      }
      const scriptBase = path.basename(scriptPath);
      const gatedEntry = AGENT_GATED_SCRIPTS[scriptBase];
      if (gatedEntry) {
        const allowedAgents = gatedEntry.agents;
        // Verify script lives in a trusted directory
        let trusted = false;
        try {
          const resolved = fs.realpathSync(path.resolve(scriptPath));
          trusted = TRUSTED_SCRIPT_DIRS.some(dir => resolved.startsWith(dir + path.sep));
        } catch { /* file not found */ }

        if (!trusted) {
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
        // Each gated script has a required step — e.g. write-*-report.js requires 'check',
        // tdd-phase-state.js requires 'implement'. Token issuance is blocked if the
        // required step is not in_progress.
        if (ticketId) {
          const state = loadStateFile(ticketId, '.work-state.json');
          const currentStep = state?.stepStatus
            ? WORK_STEPS.find(s => state.stepStatus[s] === 'in_progress') || null
            : null;
          const requiredStep = gatedEntry.step;
          // Only block when a *different* step is currently active.
          // null currentStep (no workflow running) deliberately skips gating —
          // scripts are unrestricted outside of an active workflow.
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
        // The token file is the trusted bridge between the hook (which has
        // access to Claude Code's hookData) and the script (which doesn't).
        const { tokenPath, ensureTokenDir } = require(path.join(__dirname, '..', 'scripts', 'write-report'));
        const detectedAgent = (() => {
          // Determine which agent was detected (for the token)
          const envAgent = process.env.CLAUDE_CURRENT_AGENT;
          if (envAgent && allowedAgents.some(a => normalizeAgentName(a) === normalizeAgentName(envAgent))) return envAgent;
          const hd = hookData?.tool_input?.subagent_type;
          if (hd && allowedAgents.some(a => normalizeAgentName(a) === normalizeAgentName(hd))) return hd;
          // Fallback: return first allowed agent (transcript detection confirmed match)
          return allowedAgents[0];
        })();
        try {
          ensureTokenDir();
          const tp = tokenPath(scriptBase);
          // Remove stale token if any, then create exclusively with 0600 perms
          try { fs.unlinkSync(tp); } catch { /* may not exist */ }
          const fd = fs.openSync(tp, 'wx', 0o600);
          try {
            // Bind ticketId + tasksBase into token so the script can validate reportPath scope
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
        }
        // Continue normal hook processing — don't skip workflow/transition checks
        // for compound Bash commands that may include other operations.
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
    const transition = parseTransition(toolName, toolInput, wf.transitionPattern);
    if (transition.isTransition) {
      // (Patch 10) Validate target is a real step in this workflow
      if (!wf.steps.includes(transition.targetStep)) continue;

      // Ticket-aware transition — skip if transition targets a different ticket
      if (transition.ticket !== ticketId) continue;

      // Rule 2: Block transition if current step's command wasn't executed
      if (wf.softSteps.has(currentStep)) continue; // Soft steps don't need evidence

      const evidence = loadEvidence(ticketId, wf.evidenceFile);
      if (evidence[currentStep]?.executed) continue; // Evidence exists → allow

      // Inferred evidence: check verify() functions for this step
      const verifiers = wf.commandMap.filter(m => m.step === currentStep && typeof m.verify === 'function');
      if (verifiers.some(m => m.verify(ticketId))) continue;

      // (Patch 5) Multi-command expected hint — show all valid commands with field names
      const expectedMappings = wf.commandMap.filter(m => m.step === currentStep);
      const expectedLines = expectedMappings.length > 0
        ? expectedMappings.map(m => {
            if (typeof m.verify === 'function') return `${m.step} (inferred via verify)`;
            const toolLabel = Array.isArray(m.tool) ? m.tool.join('/') : m.tool;
            if (m.field == null) return `${toolLabel} (any call)`;
            const pat = m.pattern ? m.pattern.toString() : '(any)';
            return `${toolLabel}.${m.field} matches ${pat}`;
          })
        : [`No registered command for step '${currentStep}' — add to softSteps or commandMap.`];

      // (Patch 4) Use transition.raw for attempted command
      const transitionCmd = transition.raw || '(unknown)';

      if (wf.name === 'work') {
        appendAction(ticketId, { step: currentStep, what: 'BLOCKED: transition without evidence', meta: { rule: 2 } });
      }
      didBlock = true;
      process.stderr.write(
        `BLOCKED [${wf.name}]: Cannot transition from ${currentStep} — expected command not executed.\n` +
        `Attempted: ${transitionCmd}\n` +
        `Expected one of:\n` +
        expectedLines.map(s => `  - ${s}\n`).join('') +
        `Run the expected command first, then transition.\n`
      );
      process.exit(2);
    }

    // 5. Map tool call to a step in THIS workflow (Rule 1)
    const matchedStep = matchToolToStep(toolName, toolInput, wf.commandIndex);
    if (!matchedStep) continue; // Not a step command for this workflow → skip

    // Skip /work blocking for agents legitimately used by /check
    if (wf.name === 'work' && matchedStep !== currentStep) {
      const agentType = toolInput?.subagent_type || '';
      if (CHECK_AGENTS.has(agentType)) {
        let checkState = loadStateFile(ticketId, '.check.workflow-state.json');
        if (!checkState) {
          const legacyState = loadStateFile(ticketId, '.workflow-state.json');
          if (legacyState?.workflow === 'check') checkState = legacyState; // legacy compat
        }
        if (checkState?.workflow === 'check' && checkState?.status === 'in_progress') {
          continue; // Allow — /check owns this agent
        }
      }
    }

    // Rule 1: Block if matched step ≠ currentStep
    if (matchedStep !== currentStep) {
      const cmdDesc = toolInput?.command || toolInput?.skill || toolInput?.subagent_type || '(unknown)';
      if (wf.name === 'work') {
        const truncDesc = String(cmdDesc).substring(0, 80);
        appendAction(ticketId, { step: matchedStep, what: `BLOCKED: ${truncDesc} (step ${matchedStep} not in_progress)`, meta: { rule: 1 } });
      }
      didBlock = true;
      process.stderr.write(
        `BLOCKED [${wf.name}]: Cannot run '${cmdDesc}' — step ${matchedStep} is not in_progress.\n` +
        `Current step: ${currentStep} (in_progress)\n` +
        `Call transition first:\n` +
        `  ${wf.transitionHint} ${ticketId} ${matchedStep}\n`
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
    const transition = parseTransition(toolName, toolInput, wf.transitionPattern);
    if (transition.isTransition) {
      // (Patch 10) Validate target is a real step in this workflow
      if (!wf.steps.includes(transition.targetStep)) continue;

      // (Patch 3) Ticket-aware transition gate — mirror PreToolUse
      if (transition.ticket !== ticketId) continue;

      if (currentStep && transition.targetStep) {
        const currentIdx = wf.steps.indexOf(currentStep);
        const targetIdx = wf.steps.indexOf(transition.targetStep);

        // Backward transition: clear evidence for steps AFTER target through current
        // Target step itself is preserved — we're going TO it, so redo everything after
        if (targetIdx >= 0 && currentIdx >= 0 && targetIdx < currentIdx) {
          const evidence = loadEvidence(ticketId, wf.evidenceFile);
          for (let i = targetIdx + 1; i <= currentIdx; i++) {
            delete evidence[wf.steps[i]];
          }
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
        try { head = resolveGitHead(); } catch {
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
    evidence[matchedStep] = {
      executed: true,
      command: toolInput?.command || toolInput?.skill || toolInput?.subagent_type || '(unknown)',
      tool: toolName,
      timestamp: new Date().toISOString(),
    };
    saveEvidence(ticketId, wf.evidenceFile, evidence);

    // Log action for the /work workflow
    if (wf.name === 'work') {
      let what;
      if (toolName === 'Skill') {
        what = `Skill(${toolInput?.skill || 'unknown'})`;
      } else if (toolName === 'Task' || toolName === 'Agent') {
        const label = toolInput?.subagent_type || String(toolInput?.description || 'unknown').substring(0, 60);
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
  }
}

main().catch((err) => {
  if (DEBUG) process.stderr.write(`[enforce-step-workflow] fatal: ${err?.message}\n`);
});
