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
const { isRunningInAgent } = require(path.join(__dirname, '..', 'agent-detection'));

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

// ─── Workflow Definitions ───────────────────────────────────────────────────
//
// Each workflow defines its own state file, step-to-command mapping,
// transition pattern, exemptions, and soft steps.

const { STEPS, ALL_STEPS: WORK_STEPS } = require(path.join(__dirname, '..', '..', 'work', 'step-registry'));

function verifyBootstrap(ticketId) {
  // Bootstrap is proven if the current branch contains the ticket ID
  try {
    let head;
    try {
      // Worktree: .git is a file containing "gitdir: <path>"
      head = resolveGitHead();
    } catch {
      // Normal repo: .git is a directory
      head = fs.readFileSync(path.join('.git', 'HEAD'), 'utf-8').trim();
    }
    const ref = head.startsWith('ref: ') ? head.slice(5) : head;
    return ref.includes(ticketId);
  } catch { return false; }
}

const WORKFLOWS = [
  {
    name: 'work',
    stateFile: '.work-state.json',
    evidenceFile: '.step-evidence.json',
    isActive: (state) => state?.status === 'in_progress',
    steps: WORK_STEPS,
    // Soft steps allow transition without evidence — these are optional or metadata-only steps.
    softSteps: new Set([
      STEPS.ticket,                           // optional/metadata step
      STEPS.ready, STEPS.reports,             // operational steps — no code changes to enforce
    ]),
    // Tool can be a string or array — some runtimes emit Agent instead of Task.
    commandMap: [
      { step: STEPS.bootstrap, verify: verifyBootstrap },
      { step: STEPS.ticket, verify: (ticketId) => {
        // Ticket is proven if the work state file exists and is active for this ticket
        try {
          const stateFile = path.join(TASKS_BASE, ticketId, '.work-state.json');
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          return state?.status === 'in_progress' && state?.ticketId === ticketId;
        } catch { return false; }
      }},
      { step: STEPS.brief, verify: (ticketId) => {
        try { return fs.existsSync(path.join(TASKS_BASE, ticketId, 'brief.md')); }
        catch { return false; }
      }},
      { step: STEPS.spec, verify: (ticketId) => {
        try { return fs.existsSync(path.join(TASKS_BASE, ticketId, 'spec.md')); }
        catch { return false; }
      }},
      { step: STEPS.implement, verify: (ticketId) => {
        // Implement is proven if TDD evidence confirms green (or exception)
        try {
          const evidence = JSON.parse(fs.readFileSync(
            path.join(TASKS_BASE, ticketId, '.tdd-evidence-implement.json'), 'utf-8'
          ));
          // Normal TDD: refactorConfirmed must be true (full red-green-refactor cycle)
          // Exception mode: refactorConfirmed=false is OK when exceptionReason is set (config-only, no testable behavior)
          return evidence.refactorConfirmed === true
            || (evidence.refactorConfirmed === false && !!evidence.exceptionReason);
        } catch { return false; }
      }},
      { step: STEPS.commit, verify: (ticketId) => {
        // Commit is proven if HEAD has new commits with ticketId (not empty commits)
        try {
          const { execFileSync } = require('child_process');
          const opts = { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] };
          const shaFile = path.join(TASKS_BASE, ticketId, '.last-commit-sha');
          const headSha = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim();

          let baseBranch = 'origin/main';
          try {
            const getBaseBranch = require(path.join(__dirname, '..', 'config')).getBaseBranch;
            baseBranch = getBaseBranch({ cwd: process.cwd() });
          } catch { /* fallback to origin/main */ }

          // 1. If saved SHA exists and HEAD differs → new commit was made
          try {
            const savedSha = fs.readFileSync(shaFile, 'utf-8').trim();
            if (savedSha && headSha !== savedSha) {
              // Verify it's not an empty commit (must have file changes)
              const diff = execFileSync('git', ['diff', '--shortstat', savedSha, headSha], opts).trim();
              if (!diff) return false; // Empty commit — reject
              fs.writeFileSync(shaFile, headSha);
              return true;
            }
          } catch { /* no saved SHA — first run */ }

          // 2. No saved SHA → check for commits with ticketId not on main
          const log = execFileSync('git', ['log', '--oneline', `${baseBranch}..HEAD`, '--grep', ticketId], opts).trim();
          if (log) {
            // Verify diff vs main is non-empty
            const diff = execFileSync('git', ['diff', '--shortstat', baseBranch, 'HEAD'], opts).trim();
            if (!diff) return false; // No actual changes — reject
            fs.writeFileSync(shaFile, headSha);
            return true;
          }

          // 3. No commits with ticketId → not committed yet
          return false;
        } catch { return false; }
      }},
      { step: STEPS.check, verify: (ticketId) => {
        // Check is proven if all required report files exist
        try {
          const dir = path.join(TASKS_BASE, ticketId);
          const required = ['code-review.check.md', 'tests.check.md', 'completion.check.md', 'README.md'];
          if (!required.every(f => fs.existsSync(path.join(dir, f)))) return false;
          // At least one QA report must exist (qa-*.check.md)
          const files = fs.readdirSync(dir);
          return files.some(f => /^qa-.*\.check\.md$/.test(f));
        } catch { return false; }
      }},
      { step: STEPS.check,            tool: 'Skill',           field: 'skill',         pattern: /^(work-workflow:)?check$/ },
      { step: STEPS.cleanup,          tool: ['Task', 'Agent'], field: 'description',   pattern: new RegExp(`^${STEPS.cleanup}\\b`, 'i') },
      { step: STEPS.cleanup, verify: (ticketId) => {
        // Cleanup is proven if no dev tmux session exists for this ticket
        try {
          const { execFileSync } = require('child_process');
          const result = execFileSync('tmux', ['has-session', '-t', `${ticketId}-dev`], {
            encoding: 'utf-8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
          });
          return false; // Session still exists — not cleaned up
        } catch { return true; } // Exit code 1 = session doesn't exist = cleaned up
      }},
      { step: STEPS.pr, verify: (ticketId) => {
        // PR is proven if an open PR exists for the current branch
        try {
          const { execFileSync } = require('child_process');
          const opts = { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] };
          const pr = JSON.parse(execFileSync('gh', ['pr', 'view', '--json', 'number,state'], opts).trim());
          return pr.number > 0 && pr.state === 'OPEN';
        } catch { return false; }
      }},
      { step: STEPS.follow_up, verify: (ticketId) => {
        try {
          const { execFileSync } = require('child_process');
          const os = require('os');
          const opts = { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] };

          // 1. follow-up-pr state must show finalStatus 'ready'
          const slug = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], opts).trim().replace('/', '-');
          const prNum = execFileSync('gh', ['pr', 'view', '--json', 'number', '-q', '.number'], opts).trim();
          const stateFile = path.join(os.tmpdir(), '.claude', `follow-up-pr-${slug}-${prNum}.json`);
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          if (state.finalStatus !== 'ready') return false;

          // 2. Review accountability: every PR comment must be accounted for
          const commentCount = parseInt(
            execFileSync('gh', ['api', `repos/{owner}/{repo}/pulls/${prNum}/comments`, '--jq', 'length'], opts).trim(),
            10
          );
          if (commentCount > 0) {
            const accountabilityFile = path.join(TASKS_BASE, ticketId, 'review-accountability.json');
            if (!fs.existsSync(accountabilityFile)) return false;
            const entries = JSON.parse(fs.readFileSync(accountabilityFile, 'utf-8'));
            if (!Array.isArray(entries) || entries.length < commentCount) return false;
            // Every entry must have disposition and reason
            if (!entries.every(e => e.disposition && e.reason)) return false;
            // 3. "acknowledged" entries (AI justifying a skip) require user approval
            // Agent must call AskUserQuestion and record the user's decision
            const acknowledged = entries.filter(e => e.disposition === 'acknowledged');
            if (acknowledged.length > 0) {
              if (!acknowledged.every(e => e.userApproval === true)) return false;
            }
          }

          return true;
        } catch { return false; }
      }},
      { step: STEPS.ready,            tool: ['Task', 'Agent'], field: 'description',   pattern: new RegExp(`^${STEPS.ready}\\b`, 'i') },
      { step: STEPS.ci,               tool: ['Task', 'Agent'], field: 'description',   pattern: new RegExp(`^${STEPS.ci}\\b`, 'i') },
      { step: STEPS.ci, verify: () => {
        // CI is proven if all PR checks are passing (same as follow_up verify)
        try {
          const { execFileSync } = require('child_process');
          const opts = { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] };
          const checks = JSON.parse(execFileSync('gh', ['pr', 'checks', '--json', 'state'], opts).trim());
          return checks.length > 0 && checks.every(c => c.state === 'SUCCESS' || c.state === 'SKIPPED');
        } catch { return false; }
      }},
      { step: STEPS.reports,          tool: ['Task', 'Agent'], field: 'description',   pattern: new RegExp(`^${STEPS.reports}\\b`, 'i') },
      { step: STEPS.reports, verify: (ticketId) => {
        // Reports is proven if all required check files exist and show APPROVED/COMPLETE
        try {
          const dir = path.join(TASKS_BASE, ticketId);
          const required = [
            { file: 'tests.check.md',       pattern: /Status:\s*APPROVED/i },
            { file: 'code-review.check.md',  pattern: /Status:\s*APPROVED/i },
            { file: 'completion.check.md',   pattern: /Status:\s*(COMPLETE|APPROVED)/i },
          ];
          for (const r of required) {
            const fp = path.join(dir, r.file);
            if (!fs.existsSync(fp)) return false;
            if (!r.pattern.test(fs.readFileSync(fp, 'utf-8'))) return false;
          }
          // At least one QA report must exist and pass
          const files = fs.readdirSync(dir).filter(f => /^qa-.*\.check\.md$/.test(f));
          if (files.length === 0) return false;
          return files.every(f => /Status:\s*APPROVED/i.test(fs.readFileSync(path.join(dir, f), 'utf-8')));
        } catch { return false; }
      }},
      { step: STEPS.complete,         tool: ['Task', 'Agent'], field: 'description',   pattern: new RegExp(`^${STEPS.complete}\\b`, 'i') },
      { step: STEPS.complete, verify: (ticketId) => {
        // Complete is proven if: PR exists + CI passing + all reports approved
        try {
          const { execFileSync } = require('child_process');
          const opts = { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] };
          // PR must exist and be open
          const pr = JSON.parse(execFileSync('gh', ['pr', 'view', '--json', 'number,state'], opts).trim());
          if (!pr.number || pr.state !== 'OPEN') return false;
          // CI must be passing
          const checks = JSON.parse(execFileSync('gh', ['pr', 'checks', '--json', 'state'], opts).trim());
          if (checks.length === 0 || !checks.every(c => c.state === 'SUCCESS' || c.state === 'SKIPPED')) return false;
          // All required reports must exist and pass
          const dir = path.join(TASKS_BASE, ticketId);
          const required = ['tests.check.md', 'code-review.check.md', 'completion.check.md'];
          if (!required.every(f => fs.existsSync(path.join(dir, f)))) return false;
          // At least one QA report
          const qaFiles = fs.readdirSync(dir).filter(f => /^qa-.*\.check\.md$/.test(f));
          return qaFiles.length > 0;
        } catch { return false; }
      }},
    ],
    transitionPattern: /work(?:-orchestrator|.workflow)\.js\s+transition\s+(\S+)\s+(\S+)/,
    exemptPatterns: [
      /work(?:-orchestrator|.workflow)\.js\s+(plan|transitions|graph)/,
      /work-state\.js\s+(get|resume-info|init)/,
    ],
    transitionHint: `node ${path.join(__dirname, '..', '..', 'work', 'work.workflow.js')} transition`,
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
    transitionHint: `node ${path.join(__dirname, '..', 'workflow-engine.js')} work-pr transition`,
  },
];

// Step-gated artifact files — only writable during their owning step
const ARTIFACT_RULES = [
  { basename: 'brief.md',          step: STEPS.brief, agents: ['brief-writer'] },
  { basename: 'spec.md',           step: STEPS.spec,  agents: ['spec-writer'] },
  { basename: '.last-commit-sha',  step: STEPS.commit },
  { basename: 'code-review.check.md',  step: STEPS.check, agents: ['code-checker'] },
  { basename: 'tests.check.md',        step: STEPS.check, agents: ['quality-checker'] },
  { basename: 'completion.check.md',   step: STEPS.check, agents: ['completion-checker'] },
  { pattern: /^qa-.*\.check\.md$/,     step: STEPS.check, agents: ['qa-feature-tester', 'qa-api-tester'] },
  { basename: 'code-review-reply.check.md', step: STEPS.check, agents: ['developer-nodejs-tdd', 'developer-react-senior', 'developer-devops'] },
];

// Protected state file basenames — block direct Edit/Write/MultiEdit/Bash writes
const { buildProtectedBasenames, basenameProtector, createFileProtector } = require(path.join(__dirname, '..', 'protect-state-files'));
const PROTECTED_STATE_BASENAMES = buildProtectedBasenames(WORKFLOWS, ['.work-actions.json', '.pr-update-sha']);

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

// Trusted directories where exempt scripts are allowed to live.
// Only scripts resolved under these paths are exempt — prevents basename spoofing.
const TRUSTED_SCRIPT_DIRS = [
  path.resolve(__dirname),                           // workflows/lib/hooks/
  path.resolve(__dirname, '..'),                     // workflows/lib/
  path.resolve(__dirname, '..', 'scripts'),          // workflows/lib/scripts/
  path.resolve(__dirname, '..', '..', 'work'),       // workflows/work/
];

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
    const nodePattern =
      /(?:^|&&|;|\|)\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*(?:node|nodejs)\s+(?:-[^\s]+\s+)*(?:"([^"]+)"|'([^']+)'|(\S+))/;
    const nodeMatch = cmd.match(nodePattern);
    if (nodeMatch) {
      const scriptPath = nodeMatch[1] || nodeMatch[2] || nodeMatch[3];
      const scriptBase = path.basename(scriptPath);
      if (!EXEMPT_SCRIPTS.has(scriptBase)) return false;

      // Verify the script lives in a trusted directory (prevents basename spoofing)
      // Use realpathSync to resolve symlinks — a symlink under a trusted dir pointing outside is denied
      try {
        const resolved = fs.realpathSync(path.resolve(scriptPath));
        if (TRUSTED_SCRIPT_DIRS.some(dir => resolved.startsWith(dir + path.sep))) return true;
      } catch { /* realpathSync failed (file doesn't exist) — deny */ }
      return false;
    }

    return false; // Tests: Vector 3 exempt scripts + trusted path + untrusted path + env prefix + quoted path
  },
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
    if (DEBUG) process.stderr.write(`WARNING: Multiple steps in_progress: ${active.join(', ')}. Using first.\n`);
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
  // Rule 4: Block writes to step-gated artifact files outside their owning step/agent
  // Must run BEFORE skipRemainingChecks — Edit/Write/MultiEdit need artifact protection
  const rule4 = artifactProtector.check(toolName, toolInput, hookData);
  if (rule4.blocked) {
    didBlock = true;
    process.stderr.write(rule4.message);
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

    // (Patch 14) Strengthen pr evidence: verify .pr-update-sha matches HEAD
    if (wf.name === 'work' && matchedStep === STEPS.pr) {
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
