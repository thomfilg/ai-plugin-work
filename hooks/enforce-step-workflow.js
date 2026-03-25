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
 * /work at step 11_pr). Each workflow is checked independently.
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
let appendAction;
try {
  appendAction = require(path.join(__dirname, '..', 'lib', 'work-actions')).appendAction;
} catch {
  appendAction = () => {};
}

// ─── Configuration ──────────────────────────────────────────────────────────

let _config;
try { _config = require(path.join(__dirname, '..', 'lib', 'config')); } catch { _config = null; }
const WORKTREES_BASE = _config?.WORKTREES_BASE || `${process.env.HOME}/worktrees`;
const TASKS_BASE = _config?.TASKS_BASE || path.join(WORKTREES_BASE, 'tasks');

// ─── Workflow Definitions ───────────────────────────────────────────────────
//
// Each workflow defines its own state file, step-to-command mapping,
// transition pattern, exemptions, and soft steps.

const WORKFLOWS = [
  {
    name: 'work',
    stateFile: '.work-state.json',
    evidenceFile: '.step-evidence.json',
    isActive: (state) => state?.status === 'in_progress',
    steps: [
      '1_ticket', '2_bootstrap', '3_brief', '4_spec', '5_implement', '6_quality',
      '7_commit', '8_check', '9_cleanup', '10_test_enhancement',
      '11_pr', '12_ready', '13_ci', '14_reports', '15_complete',
    ],
    // Soft steps allow transition without evidence — these are optional or metadata-only steps.
    // 3_brief and 4_spec are soft because they're toggleable via WORK_BRIEF_ENABLED/WORK_SPEC_ENABLED
    // and produce documentation artifacts, not code that requires enforcement.
    softSteps: new Set([
      '1_ticket', '3_brief', '4_spec', // optional/metadata steps (see comment above)
      '12_ready', '14_reports',         // operational steps — no code changes to enforce
    ]),
    // Tool can be a string or array — some runtimes emit Agent instead of Task.
    commandMap: [
      { step: '1_ticket',            tool: ['Task', 'Agent'], field: 'description',   pattern: /^1_ticket/i },
      { step: '3_brief',             tool: ['Task', 'Agent'], field: 'subagent_type', pattern: /^(work-workflow:)?brief-writer$/ },
      { step: '3_brief',             tool: ['Task', 'Agent'], field: 'description',   pattern: /^3_brief/i },
      { step: '4_spec',              tool: ['Task', 'Agent'], field: 'subagent_type', pattern: /^(work-workflow:)?spec-writer$/ },
      { step: '4_spec',              tool: ['Task', 'Agent'], field: 'description',   pattern: /^4_spec/i },
      { step: '5_implement',         tool: 'Skill',           field: 'skill',         pattern: /^work-implement$/ },
      { step: '6_quality',           tool: ['Task', 'Agent'], field: 'subagent_type', pattern: /^(work-workflow:)?quality-checker$/ },
      { step: '6_quality',           tool: ['Task', 'Agent'], field: 'description',   pattern: /^6_quality/i },
      { step: '6_quality',           tool: 'Bash',            field: 'command',       pattern: /^\s*(LOW_CONCURRENCY=\d+\s+)?((pnpm|npm)\s+(run\s+)?dev:check\b|([\w./-]*\/)?dev-check\.sh(\s+--[\w-]+)*)/ },
      { step: '7_commit',            tool: ['Task', 'Agent'], field: 'subagent_type', pattern: /^(work-workflow:)?commit-writer$/ },
      { step: '8_check',             tool: 'Skill',           field: 'skill',         pattern: /^check$/ },
      { step: '9_cleanup',           tool: ['Task', 'Agent'], field: 'description',   pattern: /^9_cleanup/i },
      { step: '10_test_enhancement', tool: 'Skill',           field: 'skill',         pattern: /^test-coordination$/ },
      { step: '11_pr',               tool: 'Skill',           field: 'skill',         pattern: /^work-pr$/ },
      { step: '12_ready',            tool: ['Task', 'Agent'], field: 'description',   pattern: /^12_ready/i },
      { step: '13_ci',               tool: ['Task', 'Agent'], field: 'description',   pattern: /^13_ci/i },
      { step: '14_reports',          tool: ['Task', 'Agent'], field: 'description',   pattern: /^14_reports/i },
      { step: '15_complete',         tool: ['Task', 'Agent'], field: 'description',   pattern: /^15_complete/i },
    ],
    transitionPattern: /work-orchestrator\.js\s+transition\s+(\S+)\s+(\S+)/,
    exemptPatterns: [
      /work-orchestrator\.js\s+(plan|transitions|graph)/,
      /work-state\.js\s+(get|resume-info|init)/,
    ],
    transitionHint: `node ${path.join(__dirname, 'work-orchestrator.js')} transition`,
  },
  {
    name: 'work-pr',
    stateFile: '.workflow-state.json',
    evidenceFile: '.step-evidence-work-pr.json',
    isActive: (state) => state?.status === 'in_progress' && state?.workflow === 'work-pr',
    steps: [
      '1_preflight', '2_setup', '3_pr_gen',
      '4_screenshot_gate', '5_post_pr_gen', '6_summary',
    ],
    softSteps: new Set(['1_preflight', '2_setup', '4_screenshot_gate', '6_summary']),
    commandMap: [
      { step: '3_pr_gen',       tool: 'Task',  field: 'subagent_type', pattern: /^(work-workflow:)?pr-generator$/ },
      { step: '3_pr_gen',       tool: 'Agent', field: 'subagent_type', pattern: /^(work-workflow:)?pr-generator$/ },
      { step: '3_pr_gen',       tool: 'Bash',  field: 'command', pattern: /gh\s+pr\s+create/ },
      { step: '3_pr_gen',       tool: 'Bash',  field: 'command', pattern: /gh\s+pr\s+edit/ },
      { step: '5_post_pr_gen',  tool: 'Task',  field: 'subagent_type', pattern: /^(work-workflow:)?pr-post-generator$/ },
      { step: '5_post_pr_gen',  tool: 'Agent', field: 'subagent_type', pattern: /^(work-workflow:)?pr-post-generator$/ },     ],
    transitionPattern: /workflow-engine\.js\s+work-pr\s+transition\s+(\S+)\s+(\S+)/,
    exemptPatterns: [
      /workflow-engine\.js\s+work-pr\s+(plan|transitions|graph)/,
      /workflow-state\.js\s+work-pr\s+(get|resume-info|init)/,
    ],
    transitionHint: `node ${path.join(__dirname, '..', 'lib', 'workflow-engine.js')} work-pr transition`,
  },
];

// Protected state file basenames — block direct Edit/Write/MultiEdit/Bash writes
const { buildProtectedBasenames, basenameProtector, createFileProtector } = require(path.join(__dirname, '..', 'lib', 'protect-state-files'));
const PROTECTED_STATE_BASENAMES = buildProtectedBasenames(WORKFLOWS, ['.work-actions.json', '.pr-update-sha']);

// Map each protected basename to its workflow's transition hint
const BASENAME_TO_HINT = {};
for (const wf of WORKFLOWS) {
  for (const bn of [path.basename(wf.stateFile), path.basename(wf.evidenceFile)]) {
    BASENAME_TO_HINT[bn] = wf.transitionHint;
  }
}

const stateFileProtector = createFileProtector({
  isProtected: basenameProtector(PROTECTED_STATE_BASENAMES),
  formatMessage: (match, vector) =>
    `BLOCKED: Direct ${vector} to ${match} is not allowed.\n` +
    `State files must only be modified through the orchestrator/workflow-engine scripts.\n`,
});

// (Patch 7) Validate workflow config at startup
function validateWorkflow(wf) {
  const stepSet = new Set(wf.steps);

  for (const s of wf.softSteps) {
    if (!stepSet.has(s)) throw new Error(`[${wf.name}] softSteps references unknown step: ${s}`);
  }

  for (const m of wf.commandMap) {
    if (!stepSet.has(m.step)) throw new Error(`[${wf.name}] commandMap references unknown step: ${m.step}`);
    if (m.field === undefined) throw new Error(`[${wf.name}] commandMap missing field for step: ${m.step}`);
  }
}

try {
  for (const wf of WORKFLOWS) validateWorkflow(wf);
} catch (e) {
  process.stderr.write(`WARNING: workflow config invalid: ${String(e?.message || e)}\n`);
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
  return _cachedTicketId;
}

function loadStateFile(ticketId, stateFile) {
  const p = path.join(TASKS_BASE, ticketId, stateFile);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

// Dual in_progress detection — warn but still fail-open
function getCurrentStep(state, steps) {
  if (!state?.stepStatus) return null;
  const active = steps.filter(s => state.stepStatus[s] === 'in_progress');
  if (active.length > 1) {
    process.stderr.write(`WARNING: Multiple steps in_progress: ${active.join(', ')}. Using first.\n`);
  }
  return active[0] || null;
}

function loadEvidence(ticketId, evidenceFile) {
  const p = path.join(TASKS_BASE, ticketId, evidenceFile);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return {};
  }
}

// Atomic evidence writes — write to tmp then rename
function saveEvidence(ticketId, evidenceFile, evidence) {
  const dir = path.join(TASKS_BASE, ticketId);
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
    return { isTransition: true, ticket: match[1], targetStep: match[2], raw: cmd };
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

      // (Patch 5) Multi-command expected hint — show all valid commands with field names
      const expectedMappings = wf.commandMap.filter(m => m.step === currentStep);
      const expectedLines = expectedMappings.length > 0
        ? expectedMappings.map(m => {
            const toolName = Array.isArray(m.tool) ? m.tool.join('/') : m.tool;
            if (m.field == null) return `${toolName} (any call)`;
            const pat = m.pattern ? m.pattern.toString() : '(any)';
            return `${toolName}.${m.field} matches ${pat}`;
          })
        : ['expected command'];

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
        const checkState = loadStateFile(ticketId, '.workflow-state.json');
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

    // (Patch 14) Strengthen 11_pr evidence: verify .pr-update-sha matches HEAD
    if (wf.name === 'work' && matchedStep === '11_pr') {
      const tasksDir = path.join(TASKS_BASE, ticketId);
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
          prShaOk = storedSha === ref;
        } else {
          // Can't compare ref to SHA — trust the file exists
          prShaOk = fs.existsSync(prShaFile);
        }
      } catch {
        prShaOk = false;
      }
      if (!prShaOk) {
        if (DEBUG) process.stderr.write(`[enforce] 11_pr: pr-update-sha missing or stale\n`);
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
