#!/usr/bin/env node

/**
 * work-orchestrator.js
 *
 * Pre-computes the action plan for the /work2 command.
 * Moves ALL conditional logic out of the LLM's hands into deterministic checks.
 *
 * Features:
 *   - Inspects real state (git, files, worktrees, reports, tmux)
 *   - Outputs a JSON action plan the agent follows step-by-step
 *   - Embedded state machine prevents invalid step transitions
 *   - `transition` subcommand lets agents request step changes safely
 *
 * Usage:
 *   # Generate action plan (default command — 'plan' keyword optional)
 *   node work-orchestrator.js <TICKET_ID|description> [--rework]
 *   node work-orchestrator.js plan <TICKET_ID|description> [--rework]
 *
 *   # Transition to a new step (validated by state machine)
 *   node work-orchestrator.js transition <TICKET_ID> <target_step>
 *
 *   # Show valid transitions from current step
 *   node work-orchestrator.js transitions <TICKET_ID>
 *
 *   # Show full state machine graph
 *   node work-orchestrator.js graph
 *
 * Step names (from lib/step-registry.js):
 *   ticket, bootstrap, implement,
 *   commit, check, pr, ready,
 *   ci, cleanup, reports, complete
 */

const { execSync, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

let appendAction, loadActions, analyzeActions;
try {
  const wa = require(path.join(__dirname, '..', 'lib', 'work-actions'));
  appendAction = wa.appendAction;
  loadActions = wa.loadActions;
  analyzeActions = wa.analyzeActions;
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && /['"].*lib\/work-actions['"]/.test(err.message)) {
    appendAction = () => {};
    loadActions = () => [];
    analyzeActions = () => ({});
  } else {
    throw err;
  }
}

let tp;
try {
  tp = require(path.join(__dirname, '..', 'lib', 'ticket-provider'));
} catch (err) {
  if (err && err.code === 'MODULE_NOT_FOUND' && /['"].*lib\/ticket-provider['"]/.test(err.message)) {
    tp = null;
  } else {
    throw err;
  }
}
if (!tp) process.exit(0);

// ─── Configuration ───────────────────────────────────────────────────────────

const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
const MAIN_WORKTREE_FOLDER = process.env.REPO_NAME || 'my-project';
const getConfig = require(path.join(__dirname, '..', 'lib', 'get-config'));
const WORKTREES_BASE = getConfig('WORKTREES_BASE') || '';
const TASKS_BASE = getConfig('TASKS_BASE') || (WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '');

function requirePaths() {
  const missing = [];
  if (!WORKTREES_BASE) missing.push('WORKTREES_BASE');
  if (!TASKS_BASE) missing.push('TASKS_BASE');
  if (missing.length) {
    console.log(JSON.stringify({ error: true, message: `${missing.join(', ')} not set. Set in env or ensure lib/config.js is loadable.` }));
    process.exit(1);
  }
}

// ─── Step Registry ───────────────────────────────────────────────────────────
const { STEPS, STEP_TRANSITIONS, ALL_STEPS, workflowCanTransition, createStatusTransitions, canTransition } = require(path.join(__dirname, '..', 'lib', 'step-registry'));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8', timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'], ...opts,
    }).trim();
  } catch { return ''; }
}

function fileExists(p) { try { return fs.existsSync(p); } catch { return false; } }
function readFile(p) { try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; } }

function listFiles(dir, pattern) {
  if (!fileExists(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(f => pattern instanceof RegExp ? pattern.test(f) : f.includes(pattern))
      .map(f => path.join(dir, f));
  } catch { return []; }
}

// ─── Artifact Archival (GH-130) ─────────────────────────────────────────────
// Maps steps to glob patterns of artifacts that should be archived on backward
// transitions. When the workflow loops back (e.g. check→implement), stale
// artifacts are moved to runs/runN/ so DEFER re-evaluation sees fresh state.

const STEP_ARTIFACTS = {
  [STEPS.check]:  [/^.*\.check\.md$/],
  [STEPS.pr]:     [/^\.pr-update-sha$/, /^\.post-pr-update-sha$/],
};

function archiveStepArtifacts(tasksDir, stepsToArchive) {
  if (!fileExists(tasksDir)) return null;

  // Determine next run number
  const runsDir = path.join(tasksDir, 'runs');
  let runNum = 1;
  if (fileExists(runsDir)) {
    try {
      const existing = fs.readdirSync(runsDir)
        .filter(d => /^run\d+$/.test(d))
        .map(d => parseInt(d.replace('run', ''), 10))
        .filter(n => !isNaN(n));
      if (existing.length > 0) runNum = Math.max(...existing) + 1;
    } catch { /* ignore */ }
  }

  let archived = false;
  const runDir = path.join(runsDir, `run${runNum}`);

  for (const step of stepsToArchive) {
    const patterns = STEP_ARTIFACTS[step];
    if (!patterns) continue;

    const files = patterns.flatMap(p => listFiles(tasksDir, p));
    if (files.length === 0) continue;

    if (!archived) {
      fs.mkdirSync(runDir, { recursive: true });
      archived = true;
    }

    for (const filePath of files) {
      const dest = path.join(runDir, path.basename(filePath));
      try { fs.renameSync(filePath, dest); } catch (e) {
        process.stderr.write(`work-orchestrator: failed to archive ${path.basename(filePath)}: ${e?.message || e}\n`);
      }
    }
  }

  return archived ? `runs/run${runNum}` : null;
}

function loadWorkState(ticket) {
  const p = path.join(TASKS_BASE, ticket, '.work-state.json');
  if (!fileExists(p)) return null;
  try { return JSON.parse(readFile(p)); } catch { return null; }
}

function saveWorkState(ticket, state) {
  const dir = path.join(TASKS_BASE, ticket);
  if (!fileExists(dir)) fs.mkdirSync(dir, { recursive: true });
  state.lastUpdate = new Date().toISOString();
  fs.writeFileSync(path.join(dir, '.work-state.json'), JSON.stringify(state, null, 2));
  return state;
}

function getCurrentStep(workState) {
  if (!workState?.stepStatus) return STEPS.ticket;
  for (const step of ALL_STEPS) {
    if (workState.stepStatus[step] === 'in_progress') return step;
  }
  for (const step of ALL_STEPS) {
    if (workState.stepStatus[step] !== 'completed') return step;
  }
  return STEPS.complete;
}

// ─── TDD Enforcement ────────────────────────────────────────────────────────

const TDD_GATED_STEPS = [STEPS.implement];

/**
 * Auto-detect if the project has a test setup.
 * TDD is mandatory when tests are available.
 * WORK_TDD_ENFORCE=0 explicitly disables (for testing/debugging only).
 */
function detectTestSetup(dir) {
  if (process.env.WORK_TDD_ENFORCE === '0') return false;
  if (process.env.WORK_TDD_ENFORCE === '1') return true;
  try {
    const cwd = (dir && fileExists(dir)) ? dir : process.cwd();
    const pkgPath = path.join(cwd, 'package.json');

    // Check package.json for test-related scripts
    if (fileExists(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const scripts = pkg.scripts || {};
      const hasTestScript = Object.keys(scripts).some(k =>
        /^(test|dev:test|test:unit|test:integration|vitest|jest)$/i.test(k)
      );
      if (hasTestScript) return true;
    }

    // Check for test config files
    const testConfigs = [
      'jest.config.js', 'jest.config.ts', 'jest.config.mjs',
      'vitest.config.js', 'vitest.config.ts', 'vitest.config.mts',
      '.mocharc.yml', '.mocharc.json',
    ];
    if (testConfigs.some(f => fileExists(path.join(cwd, f)))) return true;

    return false;
  } catch {
    return false;
  }
}


const TDD_PROTOCOL = `
TDD protocol (mandatory for this step):

RED phase:
1. Identify the smallest behavior change.
2. Find the nearest existing test file or create one.
3. Write the smallest focused failing test set first (usually 1-3 tests) when behavior is testable.
4. Run the smallest relevant test command and confirm RED.

GREEN phase:
5. Implement the minimum production change required.
6. Re-run the same targeted tests and confirm GREEN.

REFACTOR phase:
7. Review all modified source files for coverage gaps (files changed but not directly tested).
8. Add edge-case tests for error paths, boundary conditions, and integration points.
9. Run full test suite for modified files: pnpm dev:test (or targeted test command).
10. Confirm all tests pass after refactor — no regressions.

Record evidence:
11. Record TDD evidence using the orchestrator CLI before completing:
   node <ORCHESTRATOR_PATH> record-tdd <TICKET_ID> <step_id> \\
     --cmd "<exact test command run>" \\
     --red \\
     --green \\
     --refactored \\
     --files "file1.test.ts,file2.test.ts"
   Or for exceptions (no RED/GREEN cycle):
   node <ORCHESTRATOR_PATH> record-tdd <TICKET_ID> <step_id> \\
     --exception "config-only change, no testable behavior"

Rules:
- If literal RED-first is not appropriate (mechanical refactor, pure config, file move), set exceptionReason and use the nearest-test approach instead.
- Do NOT make local git commits during the RED/GREEN/REFACTOR cycle. Leave all changes uncommitted — the \`commit\` step handles commits with proper message formatting.
- The refactor phase includes all coverage improvement.
`.trim();

function getTddEvidencePath(ticketId, stepId) {
  const baseResolved = path.resolve(TASKS_BASE);
  const evidencePath = path.resolve(baseResolved, ticketId, `.tdd-evidence-${stepId}.json`);
  if (!evidencePath.startsWith(baseResolved + path.sep)) {
    throw new Error(`Invalid ticket id for TDD evidence path: ${ticketId}`);
  }
  return evidencePath;
}

function readTddEvidence(ticketId, stepId) {
  let p;
  try {
    p = getTddEvidencePath(ticketId, stepId);
  } catch {
    return { exists: false, parseError: true, evidence: null };
  }
  if (!fileExists(p)) return { exists: false, parseError: false, evidence: null };
  try {
    const evidence = JSON.parse(fs.readFileSync(p, 'utf-8'));
    return { exists: true, parseError: false, evidence };
  } catch {
    return { exists: true, parseError: true, evidence: null };
  }
}

function validateTddEvidence(evidence, expectedStepId) {
  if (!evidence || typeof evidence !== 'object') return { valid: false, reason: 'Evidence is null or not an object' };
  if (evidence.step !== expectedStepId) return { valid: false, reason: `Step mismatch: expected "${expectedStepId}", got "${evidence.step}"` };
  if (typeof evidence.redConfirmed !== 'boolean') return { valid: false, reason: 'redConfirmed must be a boolean' };
  if (typeof evidence.greenConfirmed !== 'boolean') return { valid: false, reason: 'greenConfirmed must be a boolean' };
  if (!Array.isArray(evidence.testFilesChanged)) return { valid: false, reason: 'testFilesChanged must be an array' };

  const hasException = typeof evidence.exceptionReason === 'string' && evidence.exceptionReason.trim() !== '';
  // In normal TDD mode, at least one test file must be listed
  if (!hasException && evidence.testFilesChanged.length === 0) {
    return { valid: false, reason: 'testFilesChanged must contain at least one file when no exceptionReason' };
  }
  if (!hasException) {
    const targetedCmd = typeof evidence.targetedTestCommand === 'string'
      ? evidence.targetedTestCommand.trim()
      : evidence.targetedTestCommand;
    if (typeof targetedCmd !== 'string' || targetedCmd === '') {
      return { valid: false, reason: 'targetedTestCommand must be a non-empty string when no exceptionReason' };
    }
    if (evidence.redConfirmed !== true) {
      return { valid: false, reason: 'redConfirmed must be true when no exceptionReason' };
    }
    if (evidence.greenConfirmed !== true) {
      return { valid: false, reason: 'greenConfirmed must be true when no exceptionReason' };
    }
    if (evidence.refactorConfirmed !== true) {
      return { valid: false, reason: 'refactorConfirmed must be true when no exceptionReason — run coverage review and edge-case tests before recording' };
    }
  }

  return { valid: true, reason: '' };
}

function recordTddEvidence(ticketId, stepId, flags) {
  if (!TDD_GATED_STEPS.includes(stepId)) {
    return { error: 'invalid_step', message: `Step "${stepId}" is not a TDD-gated step. Valid: ${TDD_GATED_STEPS.join(', ')}` };
  }

  const hasException = flags.exception !== undefined;
  const hasNormalFlags = flags.cmd !== undefined || flags.red || flags.green || flags.refactored || flags.files !== undefined;

  if (hasException && hasNormalFlags) {
    return { error: 'mixed_modes', message: 'Cannot mix --exception with --cmd/--red/--green/--refactored/--files' };
  }

  let evidence;
  if (hasException) {
    if (typeof flags.exception !== 'string' || flags.exception.trim() === '') {
      return { error: 'invalid_exception', message: '--exception must be a non-empty string' };
    }
    evidence = {
      step: stepId,
      targetedTestCommand: '',
      redConfirmed: false,
      greenConfirmed: false,
      testFilesChanged: [],
      exceptionReason: flags.exception.trim(),
    };
  } else {
    if (!flags.cmd || (typeof flags.cmd === 'string' && flags.cmd.trim() === '')) return { error: 'missing_flag', message: '--cmd is required in normal TDD mode' };
    if (!flags.red) return { error: 'missing_flag', message: '--red is required in normal TDD mode' };
    if (!flags.green) return { error: 'missing_flag', message: '--green is required in normal TDD mode' };
    if (!flags.refactored) return { error: 'missing_flag', message: '--refactored is required in normal TDD mode (confirms coverage gaps reviewed and edge-case tests added)' };
    if (!flags.files) return { error: 'missing_flag', message: '--files is required in normal TDD mode' };

    const testFiles = String(flags.files).split(',').map(f => f.trim()).filter(Boolean);
    if (testFiles.length === 0) {
      return { error: 'invalid_files', message: '--files must list at least one test file in normal TDD mode' };
    }

    // Run quality checks when --refactored is set — can't be faked
    const devCheckScript = process.env.DEV_CHECK_SCRIPT || path.join(__dirname, '..', 'scripts', 'dev-check', 'dev-check.sh');
    let qualityOutput = '';
    let qualityExitCode = 1;
    try {
      qualityOutput = execSync(`bash "${devCheckScript}" --main`, {
        encoding: 'utf-8',
        timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: process.cwd(),
      });
      qualityExitCode = 0;
    } catch (e) {
      qualityOutput = (e.stdout || '') + '\n' + (e.stderr || '');
      qualityExitCode = e.status || 1;
    }

    if (qualityExitCode !== 0) {
      return {
        error: 'quality_failed',
        message: `--refactored requires passing quality checks (lint + typecheck + test).\ndev-check.sh exited with code ${qualityExitCode}.\nOutput:\n${qualityOutput.slice(-2000)}`,
      };
    }

    evidence = {
      step: stepId,
      targetedTestCommand: flags.cmd.trim(),
      redConfirmed: true,
      greenConfirmed: true,
      refactorConfirmed: true,
      qualityCheckPassed: true,
      qualityCheckOutput: qualityOutput.slice(-1000),
      testFilesChanged: testFiles,
      exceptionReason: '',
    };
  }

  const evidencePath = getTddEvidencePath(ticketId, stepId);
  const dir = path.dirname(evidencePath);
  if (!fileExists(dir)) fs.mkdirSync(dir, { recursive: true });

  // Atomic write: temp file → rename (remove existing first for Windows compat)
  const tmpPath = evidencePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmpPath, JSON.stringify(evidence, null, 2));
  try { fs.unlinkSync(evidencePath); } catch (e) { if (e && e.code !== 'ENOENT') throw e; }
  fs.renameSync(tmpPath, evidencePath);

  return { recorded: true, path: evidencePath };
}

// ─── Reports ─────────────────────────────────────────────────────────────────

const REQUIRED_REPORTS = [
  { file: 'tests.check.md', passPattern: /Status:\s*APPROVED/i },
  { file: 'code-review.check.md', passPattern: /Status:\s*APPROVED/i },
  { file: 'completion.check.md', passPattern: /Status:\s*(COMPLETE|APPROVED)/i },
];

// ─── State Inspection ────────────────────────────────────────────────────────

function inspect(ticket, providerConfig) {
  const s = {};
  const safeName = tp.sanitizeTicketIdForPath(ticket, providerConfig);

  s.worktreeDir = path.join(WORKTREES_BASE, `${MAIN_WORKTREE_FOLDER}-${safeName}`);
  s.tasksDir = path.join(TASKS_BASE, safeName);
  s.worktreeExists = fileExists(s.worktreeDir);
  s.tasksDirExists = fileExists(s.tasksDir);

  s.workState = loadWorkState(safeName);
  s.hasStateFile = s.workState !== null;
  s.currentStep = getCurrentStep(s.workState);
  s.stepIs = (step) => s.workState?.stepStatus?.[step] || 'unknown';

  // Git
  if (s.worktreeExists) {
    const c = s.worktreeDir;
    s.branch = run(`git -C "${c}" branch --show-current`);
    s.headSha = run(`git -C "${c}" rev-parse HEAD`);
    let baseBranch = 'origin/main';
    try { baseBranch = require(path.join(__dirname, '..', 'lib', 'config')).getBaseBranch({ cwd: c }); } catch { /* */ }
    const diff = run(`git -C "${c}" diff --shortstat ${baseBranch} -- . 2>/dev/null`);
    s.hasDiffVsMain = diff !== '';
    s.diffSummary = diff || 'no changes';
    s.lastCommitMsg = run(`git -C "${c}" log -1 --format="%s" 2>/dev/null`);
    s.hasCommitWithTicket = s.lastCommitMsg.includes(ticket);
    s.uncommittedFiles = run(`git -C "${c}" status --porcelain 2>/dev/null`);
    s.hasUncommitted = s.uncommittedFiles !== '';
    s.uncommittedCount = s.hasUncommitted ? s.uncommittedFiles.split('\n').length : 0;
    s.hasUnpushed = s.branch
      ? run(`git -C "${c}" log origin/${s.branch}..HEAD --oneline 2>/dev/null`) !== ''
      : false;
  } else {
    Object.assign(s, {
      branch: null, headSha: null, hasDiffVsMain: false, diffSummary: 'no worktree',
      hasCommitWithTicket: false, hasUncommitted: false, uncommittedCount: 0,
      hasUnpushed: false, lastCommitMsg: '',
    });
  }

  // PR
  s.pr = null;
  if (s.worktreeExists && s.branch) {
    const j = run(`gh pr view "${s.branch}" --json number,state,isDraft,url 2>/dev/null`, { cwd: s.worktreeDir });
    if (j) { try { s.pr = JSON.parse(j); } catch {} }
  }

  // Reports
  s.reports = {}; s.allReportsPass = true; s.missingReports = []; s.failedReports = [];
  for (const { file, passPattern } of REQUIRED_REPORTS) {
    const fp = path.join(s.tasksDir, file);
    if (!fileExists(fp)) {
      s.reports[file] = { exists: false, passes: false };
      s.allReportsPass = false; s.missingReports.push(file);
    } else {
      const passes = passPattern.test(readFile(fp));
      s.reports[file] = { exists: true, passes };
      if (!passes) { s.allReportsPass = false; s.failedReports.push(file); }
    }
  }
  for (const qp of listFiles(s.tasksDir, /^qa-.*\.check\.md$/)) {
    const name = path.basename(qp);
    const passes = /Status:\s*APPROVED/i.test(readFile(qp));
    s.reports[name] = { exists: true, passes };
    s.qaReportCount = (s.qaReportCount || 0) + 1;
    if (!passes) { s.allReportsPass = false; s.failedReports.push(name); }
  }

  // SHA tracking
  s.prUpdateSha = fileExists(path.join(s.tasksDir, '.pr-update-sha'))
    ? readFile(path.join(s.tasksDir, '.pr-update-sha')).trim() : null;
  s.postPrUpdateSha = fileExists(path.join(s.tasksDir, '.post-pr-update-sha'))
    ? readFile(path.join(s.tasksDir, '.post-pr-update-sha')).trim() : null;
  s.prEverUpdated = s.prUpdateSha !== null;
  s.prShaMatch = !!(s.headSha && s.prUpdateSha && s.headSha === s.prUpdateSha);

  // Content SHA
  if (s.tasksDirExists) {
    const qaContent = listFiles(s.tasksDir, /^qa-.*\.check\.md$/).map(f => readFile(f)).join('');
    const ssDir = path.join(s.tasksDir, 'screenshots');
    let ssContent = '';
    if (fileExists(ssDir)) {
      const files = run(`find "${ssDir}" -type f 2>/dev/null | sort`);
      if (files) ssContent = files.split('\n').map(f => { try { return fs.readFileSync(f); } catch { return ''; } }).join('');
    }
    s.contentSha = (qaContent || ssContent)
      ? crypto.createHash('sha256').update(qaContent + ssContent).digest('hex') : null;
    s.postPrShaMatch = !!(s.contentSha && s.contentSha === s.postPrUpdateSha);
  }

  s.hasBrief = fileExists(path.join(s.tasksDir, 'brief.md'));
  s.hasSpec = fileExists(path.join(s.tasksDir, 'spec.md'));

  // Dev session
  s.hasDevSession = run(`tmux has-session -t "${ticket}-dev" 2>/dev/null && echo yes`) === 'yes';

  return s;
}

// ─── Plan Generation ─────────────────────────────────────────────────────────

function generatePlan(ticket, description, s, rework, callerProviderCfg) {
  const plan = [];
  const mode = rework ? 'rework' : 'resume';
  const t = ticket || '{TICKET}';
  const safeName = ticket ? tp.sanitizeTicketIdForPath(t, callerProviderCfg) : t;
  const worktreeDir = s?.worktreeDir || `${WORKTREES_BASE}/${MAIN_WORKTREE_FOLDER}-${safeName}`;
  const tasksDir = s?.tasksDir || `${TASKS_BASE}/${safeName}`;

  const tddEnforce = detectTestSetup(worktreeDir);

  // Initialize session guard for workflow locking (skip when explicitly disabled)
  if (ticket && process.env.SESSION_GUARD_ENABLED !== '0') {
    try {
      const guardPath = path.join(__dirname, 'session-guard.js');
      // init is idempotent: reuses existing session if one exists for this ticket
      execFileSync(process.execPath, [guardPath, 'init', ticket, '/work'], { stdio: 'pipe', timeout: 5000 });
    } catch { /* fail-open: session-guard init failure must not block plan generation */ }
  }

  function add(stepName, action, command, reason, extra = {}) {
    // Augment TDD-gated steps with protocol instructions
    if (tddEnforce && TDD_GATED_STEPS.includes(stepName) && extra.agentPrompt && (action === 'RUN' || action === 'DEFER')) {
      const resolvedProtocol = TDD_PROTOCOL
        .replace(/<ORCHESTRATOR_PATH>/g, path.join(__dirname, 'work-orchestrator.js'))
        .replace(/<TICKET_ID>/g, t)
        .replace(/<step_id>/g, stepName);
      extra.agentPrompt = `${extra.agentPrompt}\n\n${resolvedProtocol}`;
    }
    plan.push({ step: stepName, action, ...(command ? { command } : {}), reason, ...extra });
  }

  // ticket
  const providerConfig = tp.getProviderConfig({ skipPrompt: true });
  if (!ticket) {
    const createAgent = tp.getCreateTicketAgentType(providerConfig) || 'general-purpose';
    const createPrompt = tp.getCreateTicketPrompt(description, providerConfig) || `Create a ticket from this description: "${description}"`;
    add(STEPS.ticket, 'RUN', `Task(${createAgent})`, `Create ticket from: "${description}"`, {
      agentType: createAgent,
      agentPrompt: createPrompt,
    });
  } else {
    const fetchPrompt = tp.getFetchTicketPrompt(ticket, providerConfig) || `Fetch ticket ${ticket} details. Return the summary, description, status, and acceptance criteria.`;
    add(STEPS.ticket, 'RUN', 'Task(general-purpose)', 'Fetch ticket details', {
      agentType: 'general-purpose',
      agentPrompt: fetchPrompt,
    });
  }

  // bootstrap
  if (s?.worktreeExists && s?.pr) {
    add(STEPS.bootstrap, 'SKIP', null, `Worktree + PR #${s.pr.number} exist`);
  } else if (s?.worktreeExists) {
    add(STEPS.bootstrap, 'RUN', `/bootstrap ${ticket}`, 'Worktree exists but no PR', {
      agentType: 'skill',
      agentPrompt: `/bootstrap ${ticket}`,
    });
  } else {
    add(STEPS.bootstrap, 'RUN', `/bootstrap ${t}`, 'No worktree found', {
      agentType: 'skill',
      agentPrompt: `/bootstrap ${t}`,
    });
  }

  const transitionPrompt = tp.getTransitionPrompt(t, 'In Development', providerConfig);
  if (transitionPrompt) {
    add('2b_transition', 'RUN',
      'Task(general-purpose)',
      'Ticket → In Development (idempotent)', {
        agentType: 'general-purpose',
        agentPrompt: transitionPrompt,
      });
  } else {
    add('2b_transition', 'SKIP', null, 'No ticket transition for this provider');
  }

  // ─── Docs Injection Helper ──────────────────────────────────────────────
  function getDocsPrompt(envVar) {
    const docs = process.env[envVar] || '';
    if (!docs.trim()) return '';
    const paths = docs.split(',').map(p => p.trim()).filter(Boolean);
    return `\n\nRead these docs before starting (from ${envVar}):\n${paths.map(p => `- ${p}`).join('\n')}`;
  }

  // brief
  const briefEnabled = process.env.WORK_BRIEF_ENABLED !== '0'; // on by default
  const specEnabled = process.env.WORK_SPEC_ENABLED !== '0';   // on by default

  if (!briefEnabled) {
    add(STEPS.brief, 'SKIP', null, 'Brief generation disabled (WORK_BRIEF_ENABLED=0)');
  } else if (s?.hasBrief) {
    add(STEPS.brief, 'SKIP', null, 'brief.md already exists');
  } else {
    add(STEPS.brief, 'RUN', 'Task(brief-writer)', 'Generate product brief from ticket requirements', {
      agentType: 'brief-writer',
      agentPrompt: `Generate a product brief for ticket ${t} based on the ticket requirements fetched in the previous step.\n\nSave the brief to: ${path.join(tasksDir, 'brief.md')}\n\nStructure it with: Problem Statement, Goal, Target Users, Requirements (P0/P1/P2), Constraints, Out of Scope, Success Metrics, Open Questions.${getDocsPrompt('READ_DOCS_ON_BRIEF')}`,
    });
  }

  // ─── Planning Docs Discovery ────────────────────────────────────────────
  // Build a context string for agents that should consume planning artifacts
  const briefPath = path.join(tasksDir, 'brief.md');
  const specPath = path.join(tasksDir, 'spec.md');
  let prePlanningFiles = [];
  if (fileExists(tasksDir)) {
    try {
      const found = run(`find "${tasksDir}" -name "pre-planning.md" -type f 2>/dev/null`);
      if (found) prePlanningFiles = found.split('\n').filter(Boolean);
    } catch { /* race: tasksDir removed between exists-check and find */ }
  }
  const planningDocs = [];
  if (fileExists(briefPath)) {
    planningDocs.push(`- Brief: ${briefPath}`);
  } else if (briefEnabled) {
    planningDocs.push(`- Brief (if present after brief step): ${briefPath}`);
  }
  if (fileExists(specPath)) {
    planningDocs.push(`- Spec: ${specPath}`);
  } else if (specEnabled) {
    planningDocs.push(`- Spec (if present after spec step): ${specPath}`);
  }
  prePlanningFiles.forEach(f => planningDocs.push(`- Pre-planning: ${f}`));
  const planningContext = planningDocs.length > 0
    ? `\n\nPlanning documents — read these if they exist for requirements, test scenarios, reusable components:\n${planningDocs.join('\n')}`
    : '';

  // spec
  if (!specEnabled) {
    add(STEPS.spec, 'SKIP', null, 'Spec generation disabled (WORK_SPEC_ENABLED=0)');
  } else if (s?.hasSpec) {
    add(STEPS.spec, 'SKIP', null, 'spec.md already exists');
  } else {
    const briefRef = fileExists(briefPath) || (briefEnabled && !s?.hasBrief)
      ? `\n\nRead the product brief at: ${briefPath}`
      : '';
    add(STEPS.spec, 'RUN', 'Task(spec-writer)', 'Generate technical specification', {
      agentType: 'spec-writer',
      agentPrompt: `Analyze the codebase in ${worktreeDir} and generate a technical specification for ticket ${t}.${briefRef}\n\nSave the spec to: ${specPath}\n\nThe spec MUST include:\n1. Summary\n2. Architecture decisions (reference specific files)\n3. Data model changes\n4. API/interface changes\n5. Security considerations\n6. Test scenarios in Given/When/Then format (5-10 scenarios)\n7. Reuse Audit — grep/glob for existing patterns, components, utilities that can be reused\n8. Implementation Order — numbered steps with explicit dependency notation\n9. Files to create/modify\n10. Out of Scope — explicitly list what is NOT being implemented\n11. Open Questions & Decisions — surface ambiguity with default assumptions\n12. Dependencies — external libs, services, or internal modules needed${getDocsPrompt('READ_DOCS_ON_SPEC')}`,
    });
  }

  // implement
  const implementMeta = {
    agentType: 'skill',
    agentPrompt: `/work-implement <requirements>${planningContext}${getDocsPrompt('READ_DOCS_ON_DEV')}`,
  };
  const implementPreviouslyCompleted = s?.stepIs(STEPS.implement) === 'completed';
  if (implementPreviouslyCompleted && s?.hasDiffVsMain) {
    // DEFER only when implement was previously completed AND diffs exist (GH-130)
    // Previously: any diff triggered DEFER, even if unrelated to current task
    add(STEPS.implement, 'DEFER', '/work-implement <requirements>', `Previously completed; changes exist: ${s.diffSummary}`, implementMeta);
  } else {
    add(STEPS.implement, 'RUN', '/work-implement <requirements>', s?.hasDiffVsMain ? `Changes exist but implement not yet completed` : 'No changes vs main', implementMeta);
  }

  // commit
  if (s?.hasUncommitted) {
    add(STEPS.commit, 'RUN', 'Task(commit-writer)', `${s.uncommittedCount} uncommitted file(s)`, {
      agentType: 'commit-writer',
      agentPrompt: `autonomous - commit staged changes for ${t}`,
    });
  } else if (s?.hasCommitWithTicket) {
    add(STEPS.commit, 'DEFER', 'Task(commit-writer)', `Latest: "${s.lastCommitMsg}"`, {
      agentType: 'commit-writer',
      agentPrompt: `autonomous - commit staged changes for ${t}`,
    });
  } else if (!s?.hasDiffVsMain) {
    add(STEPS.commit, 'PENDING', null, 'Depends on implement');
  } else {
    add(STEPS.commit, 'RUN', 'Task(commit-writer)', 'Commit missing ticket ID', {
      agentType: 'commit-writer',
      agentPrompt: `autonomous - commit staged changes for ${t}`,
    });
  }

  // check
  if (rework) {
    add(STEPS.check, 'RUN', '/check', 'REWORK: Always re-run', {
      agentType: 'skill',
      agentPrompt: '/check',
      preCommands: [
        `rm -f "${tasksDir}"/*.check.md`,
        `rm -f "${tasksDir}"/.pr-update-sha`,
        `rm -f "${tasksDir}"/.post-pr-update-sha`,
      ],
    });
  } else if (s?.allReportsPass && Object.keys(s.reports).length >= 3) {
    add(STEPS.check, 'DEFER', '/check', `RESUME: All ${Object.keys(s.reports).length} reports PASS`, {
      agentType: 'skill',
      agentPrompt: '/check',
    });
  } else {
    const p = [];
    if (s?.missingReports?.length) p.push(`missing: ${s.missingReports.join(', ')}`);
    if (s?.failedReports?.length) p.push(`failed: ${s.failedReports.join(', ')}`);
    add(STEPS.check, 'RUN', '/check', p.length ? p.join('; ') : 'No reports found', {
      agentType: 'skill',
      agentPrompt: '/check',
    });
  }

  // pr
  if (rework) {
    add(STEPS.pr, 'RUN', `/work-pr ${ticket} --force`, 'REWORK: Force update', {
      agentType: 'skill',
      agentPrompt: `/work-pr ${ticket} --force`,
    });
  } else if (s?.prShaMatch && s?.prEverUpdated && (s?.postPrShaMatch || !s?.contentSha)) {
    add(STEPS.pr, 'DEFER', `/work-pr ${ticket || t}`, `SHA match (${s.headSha?.substring(0, 8)}, content: ${s?.postPrShaMatch ? 'match' : 'n/a'})`, {
      agentType: 'skill',
      agentPrompt: `/work-pr ${ticket || t}`,
    });
  } else if (s?.prEverUpdated) {
    add(STEPS.pr, 'RUN', `/work-pr ${ticket}`, `HEAD: ${s.prUpdateSha?.substring(0, 8) || '?'} → ${s.headSha?.substring(0, 8) || '?'}`, {
      agentType: 'skill',
      agentPrompt: `/work-pr ${ticket}`,
    });
  } else {
    add(STEPS.pr, 'RUN', `/work-pr ${t}`, 'Must run once', {
      agentType: 'skill',
      agentPrompt: `/work-pr ${t}`,
    });
  }

  // ready
  if (s?.pr && !s.pr.isDraft) {
    add(STEPS.ready, 'SKIP', null, 'Already ready');
  } else {
    add(STEPS.ready, 'RUN', 'Task(Bash)', 'Mark PR ready', {
      agentType: 'Bash',
      agentPrompt: `Run in ${worktreeDir}: gh pr ready`,
    });
  }

  // follow_up
  if (!s?.pr || s.pr.isDraft) {
    add(STEPS.follow_up, 'DEFER', 'Skill(follow-up-pr)', !s?.pr ? 'No PR exists' : 'PR is still draft', {
      agentType: 'skill',
      agentPrompt: `/follow-up-pr`,
    });
  } else {
    add(STEPS.follow_up, 'RUN', 'Skill(follow-up-pr)', 'Address bot review comments and CI issues', {
      agentType: 'skill',
      agentPrompt: `/follow-up-pr`,
    });
  }

  // ci → cleanup → reports → complete
  add(STEPS.ci, 'RUN', 'Task(Bash)', 'Wait for CI', {
    agentType: 'Bash',
    agentPrompt: `Run in ${worktreeDir}: gh pr checks --watch --interval 60\n\nReturn PASS if all checks pass, FAIL with details if any fail.`,
  });

  // cleanup (after CI, before reports) — DEFER when no session yet, it may start during implement
  if (s?.hasDevSession) {
    add(STEPS.cleanup, 'RUN', `Task(Bash)`, 'Dev session running', {
      agentType: 'Bash',
      agentPrompt: `Run: tmux kill-session -t "${ticket}-dev" 2>/dev/null; echo "Cleanup done"`,
    });
  } else {
    add(STEPS.cleanup, 'DEFER', `Task(Bash)`, 'No dev session yet — re-check at step time', {
      agentType: 'Bash',
      agentPrompt: `Run: tmux kill-session -t "${ticket}-dev" 2>/dev/null; echo "Cleanup done (or no session)"`,
    });
  }

  add(STEPS.reports, 'RUN', 'Task(Bash)', 'Move reports to tasks/', {
    agentType: 'Bash',
    agentPrompt: `Verify and consolidate reports in ${tasksDir}. List all *.check.md files and confirm they exist. Report the count and status of each.`,
  });
  const guardPath = path.join(__dirname, 'session-guard.js');
  add(STEPS.complete, 'RUN', 'Task(Bash)', 'Finish', {
    agentType: 'Bash',
    agentPrompt: [
      `Run these commands in sequence:`,
      `1. node "${path.join(__dirname, 'work-state.js')}" complete ${safeName}`,
      `2. node "${guardPath}" finish ${safeName}`,
      ``,
      `Step 1 marks the workflow as complete (exits 0 on success).`,
      `Step 2 is an atomic teardown: reveals the session passphrase (unlocking the Stop hook) and removes the session file. Exits 0 when no session exists (guard disabled or already cleaned up). Exits 1 only if called without a ticket ID (programming error).`,
    ].join('\n'),
  }); // complete — must run after all other steps

  return { ticket: ticket || `TBD ("${description}")`, mode, plan };
}

// ─── Check-to-PR Gate (GH-121) ──────────────────────────────────────────────
// Declarative array of checks — each returns an array of failure reasons (empty = pass).
// Mirrors the { step, verify } pattern used in enforce-step-workflow.js.

const CHECK_GATE_RULES = [
  {
    name: 'required-reports',
    description: 'All required .check.md reports must exist with accepted status (APPROVED or COMPLETE)',
    check(dir) {
      const required = [
        { file: 'tests.check.md',       pattern: /Status:\s*APPROVED/i },
        { file: 'code-review.check.md', pattern: /Status:\s*APPROVED/i },
        { file: 'completion.check.md',  pattern: /Status:\s*(COMPLETE|APPROVED)/i },
      ];
      const reasons = [];
      for (const req of required) {
        const fp = path.join(dir, req.file);
        if (!fileExists(fp)) { reasons.push(`Missing report: ${req.file}`); continue; }
        if (!req.pattern.test(readFile(fp))) {
          reasons.push(`Report ${req.file} does not contain the required Status: line`);
        }
      }
      return reasons;
    },
  },
  {
    name: 'qa-reports',
    description: 'At least one qa-*.check.md must exist, all must have Status: APPROVED',
    check(dir) {
      const qaFiles = listFiles(dir, /^qa-.*\.check\.md$/);
      if (qaFiles.length === 0) return ['No QA reports found (need at least one qa-*.check.md)'];
      return qaFiles
        .filter(f => !/Status:\s*APPROVED/i.test(readFile(f)))
        .map(f => `QA report ${path.basename(f)} does not have Status: APPROVED`);
    },
  },
  {
    name: 'running-agents',
    description: 'No check-agent tmux sessions may be running',
    check(_dir, ticket) {
      const agents = ['code-checker', 'quality-checker', 'completion-checker', 'qa-feature-tester', 'qa-api-tester'];
      const reasons = [];
      for (const agent of agents) {
        const sessionName = `${ticket}-${agent}`;
        try {
          execFileSync('tmux', ['has-session', '-t', sessionName], {
            timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'],
          });
          reasons.push(`Check agent still running: ${agent} (tmux session: ${sessionName})`);
        } catch (err) {
          // exit code 1 = session not found (expected). Log other failures for debugging.
          const isSessionNotFound = err && typeof err.status === 'number' && err.status === 1;
          if (!isSessionNotFound && err) {
            const details = [];
            if (err.status != null) details.push(`status=${err.status}`);
            if (err.signal != null) details.push(`signal=${err.signal}`);
            if (err.code) details.push(`code=${err.code}`);
            process.stderr.write(
              `work-orchestrator: tmux has-session check failed for ${sessionName}` +
              (details.length ? ` (${details.join(', ')})` : '') + '\n'
            );
          }
        }
      }
      return reasons;
    },
  },
];

/**
 * Validates whether all quality-gate prerequisites are met before
 * transitioning from `check` to `pr`. Iterates CHECK_GATE_RULES and
 * collects all failure reasons.
 *
 * @param {string} ticket - The ticket ID (e.g. "PROJ-123")
 * @returns {{ valid: boolean, reasons: string[] }}
 */
function validateCheckGate(ticket) {
  const dir = path.join(TASKS_BASE, ticket);
  const reasons = CHECK_GATE_RULES.flatMap(rule => rule.check(dir, ticket));
  return { valid: reasons.length === 0, reasons };
}

// ─── Transition Command ──────────────────────────────────────────────────────

function transitionStep(ticket, targetStep) {
  if (!ALL_STEPS.includes(targetStep)) {
    return { error: true, message: `Invalid step: "${targetStep}"`, validSteps: ALL_STEPS };
  }

  let ws = loadWorkState(ticket);
  const currentStep = getCurrentStep(ws);

  if (!workflowCanTransition(currentStep, targetStep)) {
    return {
      error: true,
      message: `BLOCKED: ${currentStep} → ${targetStep}`,
      from: currentStep,
      to: targetStep,
      allowed: STEP_TRANSITIONS[currentStep] || [],
      hint: `From ${currentStep} you can go to: ${(STEP_TRANSITIONS[currentStep] || []).join(', ') || '(terminal)'}`,
    };
  }

  // TDD gate: require evidence before leaving gated steps
  const tddEnforce = detectTestSetup(process.cwd());
  if (tddEnforce && TDD_GATED_STEPS.includes(currentStep) && currentStep !== targetStep) {
    const { exists, parseError, evidence } = readTddEvidence(ticket, currentStep);
    if (!exists || parseError) {
      const orchPath = path.resolve(__dirname, 'work-orchestrator.js');
      const msg = `Cannot leave ${currentStep} without TDD evidence. Record it via:\n  node ${orchPath} record-tdd ${ticket} ${currentStep} --cmd "<test command>" --red --green --refactored --files "<test files>"\nOr for exceptions:\n  node ${orchPath} record-tdd ${ticket} ${currentStep} --exception "<reason>"`;
      return { error: true, message: msg };
    }
    const validation = validateTddEvidence(evidence, currentStep);
    if (!validation.valid) {
      return { error: true, message: `TDD evidence invalid: ${validation.reason}` };
    }
  }

  // Check-to-PR gate (GH-121): mandatory quality safeguard — always enabled, no toggle.
  // Blocks check→pr unless all reports exist, pass, and no agents are running.
  const isCheckToPr = currentStep === STEPS.check && targetStep === STEPS.pr;
  if (isCheckToPr) {
    const checkGate = validateCheckGate(ticket);
    if (!checkGate.valid) {
      return {
        error: true,
        message: `BLOCKED: check -> pr -- quality gate not satisfied`,
        gate: 'check-to-pr',
        reasons: checkGate.reasons,
        hint: 'Wait for all check agents to finish and ensure reports pass before transitioning to pr.',
      };
    }
  }

  // Stale evidence cleanup: delete evidence when transitioning INTO a gated step
  if (tddEnforce && TDD_GATED_STEPS.includes(targetStep)) {
    try {
      const evidencePath = getTddEvidencePath(ticket, targetStep);
      fs.unlinkSync(evidencePath);
    } catch (e) {
      if (e && e.code !== 'ENOENT') { /* ignore path-traversal or missing file errors */ }
    }
  }

  // Initialize state if needed
  if (!ws) {
    ws = {
      ticketId: ticket, description: '', currentStep: 1, status: 'in_progress',
      stepStatus: {}, checkProgress: {},
      errors: [], startTime: new Date().toISOString(), lastUpdate: new Date().toISOString(),
    };
    ALL_STEPS.forEach(s => { ws.stepStatus[s] = 'pending'; });
    appendAction(ticket, { step: STEPS.ticket, what: 'workflow started' });
  }

  const currentIdx = ALL_STEPS.indexOf(currentStep);
  const targetIdx = ALL_STEPS.indexOf(targetStep);

  // Mark current as completed
  ws.stepStatus[currentStep] = 'completed';
  appendAction(ticket, { step: currentStep, what: 'step completed' });

  ws.stepStatus[targetStep] = 'in_progress';
  appendAction(ticket, { step: targetStep, what: 'step started' });

  ws.currentStep = targetIdx + 1;

  if (targetIdx < currentIdx) {
    // Going backward (retry loop) — reset intermediate steps and archive artifacts
    const stepsToReset = [];
    for (let i = targetIdx + 1; i <= currentIdx; i++) {
      ws.stepStatus[ALL_STEPS[i]] = 'pending';
      stepsToReset.push(ALL_STEPS[i]);
      appendAction(ticket, { step: ALL_STEPS[i], what: 'step reset' });
    }
    const tasksDir = path.join(TASKS_BASE, ticket);
    const archivePath = archiveStepArtifacts(tasksDir, stepsToReset);
    if (archivePath) {
      appendAction(ticket, { step: currentStep, what: `artifacts archived to ${archivePath}` });
    }
  } else {
    // Going forward — mark skipped intermediates as completed
    for (let i = currentIdx + 1; i < targetIdx; i++) {
      if (ws.stepStatus[ALL_STEPS[i]] === 'pending') {
        ws.stepStatus[ALL_STEPS[i]] = 'completed';
        appendAction(ticket, { step: ALL_STEPS[i], what: 'step skipped' });
      }
    }
  }

  saveWorkState(ticket, ws);

  return {
    success: true, from: currentStep, to: targetStep,
    direction: targetIdx > currentIdx ? 'forward' : 'backward',
    message: `${currentStep} → ${targetStep}`,
  };
}

function getAvailableTransitions(ticket) {
  const ws = loadWorkState(ticket);
  const current = getCurrentStep(ws);
  return {
    ticket, currentStep: current,
    status: ws?.stepStatus?.[current] || 'unknown',
    allowed: STEP_TRANSITIONS[current] || [],
    allStatuses: ws?.stepStatus || {},
  };
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log(JSON.stringify({ error: true, message: 'Usage: work-orchestrator.js [plan|transition|transitions|graph] <args>' }));
    process.exit(1);
  }

  const subcommands = ['plan', 'transition', 'transitions', 'graph', 'actions', 'record-tdd'];
  const command = subcommands.includes(args[0]) ? args[0] : 'plan';
  const rest = subcommands.includes(args[0]) ? args.slice(1) : args;

  switch (command) {
    case 'plan': {
      requirePaths();
      const rework = rest.includes('--rework');
      let raw = rest.filter(a => a !== '--rework').join(' ').trim();
      if (!raw) { console.log(JSON.stringify({ error: true, message: 'Provide ticket ID or description' })); process.exit(1); }

      let providerConfig = tp.getProviderConfig({ skipPrompt: true });
      const isGitHub = providerConfig?.provider === 'github';

      // Detect GitHub issue URLs — only when provider is GitHub or auto-detect from URL
      let ghUrlMeta = null;
      const ghParsed = tp.parseGitHubUrl(raw);
      if (ghParsed && (isGitHub || !providerConfig)) {
        ghUrlMeta = ghParsed;
        raw = '#' + ghParsed.number;
      }
      // Auto-detect GitHub provider from #N shorthand when no provider is configured.
      // providerConfig is declared as `let` (line 795) to allow this reassignment.
      if (/^#\d+$/.test(raw) && !isGitHub && !providerConfig) {
        providerConfig = { provider: 'github', projectKey: '' }; // auto-detected
      }
      const isGitHubEffective = providerConfig?.provider === 'github';
      const isJiraTicket = /^[A-Z]+-\d+$/i.test(raw);
      const isGitHubIssue = /^#?\d+$/.test(raw) && isGitHubEffective;
      const isGitHubPrefixed = /^GH-\d+$/i.test(raw) && isGitHubEffective;
      const isTicket = isJiraTicket || isGitHubIssue || isGitHubPrefixed;
      let ticket = isTicket ? raw.toUpperCase() : null;
      // For GitHub provider, normalize to canonical #N form
      if (isTicket && isGitHubEffective) {
        const num = raw.replace(/^#|^GH-/i, '');
        ticket = '#' + num;
      }
      // Enrich provider config with owner/repo from parsed URL for ticketUrl generation
      // Thread owner/repo from parsed URL into providerConfig for ticketUrl()
      if (ghUrlMeta && isGitHubEffective) {
        providerConfig.owner = ghUrlMeta.owner;
        providerConfig.repo = ghUrlMeta.repo;
      }
      const state = ticket ? inspect(ticket, providerConfig) : null;
      const result = generatePlan(ticket, isTicket ? null : raw, state, rework, providerConfig);

      result.timestamp = new Date().toISOString();
      if (ghUrlMeta && providerConfig) {
        result.ticketUrl = tp.ticketUrl(ticket, providerConfig);
      }
      if (state) {
        result.currentStep = state.currentStep;
        result.allowedTransitions = STEP_TRANSITIONS[state.currentStep] || [];
        result.state = {
          worktreeExists: state.worktreeExists, branch: state.branch,
          headSha: state.headSha?.substring(0, 8) || null,
          hasDiffVsMain: state.hasDiffVsMain, diffSummary: state.diffSummary,
          lastCommitMsg: state.lastCommitMsg,
          hasUncommitted: state.hasUncommitted, uncommittedCount: state.uncommittedCount,
          hasUnpushed: state.hasUnpushed,
          pr: state.pr ? { number: state.pr.number, isDraft: state.pr.isDraft } : null,
          reports: state.reports, allReportsPass: state.allReportsPass,
          missingReports: state.missingReports, failedReports: state.failedReports,
          prEverUpdated: state.prEverUpdated, prShaMatch: state.prShaMatch,
          hasDevSession: state.hasDevSession, workStateStatus: state.workState?.status || null,
        };
      }
      const by = (a) => result.plan.filter(s => s.action === a);
      result.summary = {
        total: result.plan.length,
        run: by('RUN').length, skip: by('SKIP').length, defer: by('DEFER').length, pending: by('PENDING').length,
        firstAction: by('RUN')[0]?.step || by('DEFER')[0]?.step || 'none',
        stepsToRun: by('RUN').map(s => s.step),
        stepsDeferred: by('DEFER').map(s => s.step), // separate from stepsToRun: agent re-plans before executing
        stepsSkipped: by('SKIP').map(s => s.step),
      };
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'transition': {
      requirePaths();
      if (rest.length < 2) {
        console.log(JSON.stringify({ error: true, message: 'Usage: transition <TICKET> <step>', validSteps: ALL_STEPS }));
        process.exit(1);
      }
      const transProviderCfg = tp.getProviderConfig({ skipPrompt: true });
      // Normalize: uppercase for Jira/Linear, then sanitize for GitHub path safety
      const transTicket = transProviderCfg?.provider === 'github' ? rest[0] : rest[0].toUpperCase();
      const safeTransTicket = tp.sanitizeTicketIdForPath(transTicket, transProviderCfg);
      console.log(JSON.stringify(transitionStep(safeTransTicket, rest[1]), null, 2));
      break;
    }

    case 'transitions': {
      requirePaths();
      if (!rest[0]) { console.log(JSON.stringify({ error: true, message: 'Usage: transitions <TICKET>' })); process.exit(1); }
      const transitionsProviderCfg = tp.getProviderConfig({ skipPrompt: true });
      const transitionsTicket = transitionsProviderCfg?.provider === 'github' ? rest[0] : rest[0].toUpperCase();
      const safeTransitionsTicket = tp.sanitizeTicketIdForPath(transitionsTicket, transitionsProviderCfg);
      console.log(JSON.stringify(getAvailableTransitions(safeTransitionsTicket), null, 2));
      break;
    }

    case 'graph': {
      console.log(JSON.stringify({ steps: ALL_STEPS, transitions: STEP_TRANSITIONS }, null, 2));
      break;
    }

    case 'actions': {
      requirePaths();
      if (!rest[0]) {
        console.log(JSON.stringify({ error: true, message: 'Usage: actions <TICKET> [--raw]' }));
        process.exit(1);
      }
      const actionsProviderCfg = tp.getProviderConfig({ skipPrompt: true });
      const ticket = tp.sanitizeTicketIdForPath(actionsProviderCfg?.provider === 'github' ? rest[0] : rest[0].toUpperCase(), actionsProviderCfg);
      const raw = rest.includes('--raw');
      const actions = loadActions(ticket);
      if (raw) {
        console.log(JSON.stringify({ ticket, actions }, null, 2));
      } else {
        const analysis = analyzeActions(actions);
        console.log(JSON.stringify({ ticket, analysis, actions }, null, 2));
      }
      break;
    }

    case 'record-tdd': {
      requirePaths();
      if (rest.length < 2) {
        console.error(JSON.stringify({ error: 'usage', message: 'Usage: record-tdd <TICKET_ID> <STEP_ID> [--cmd "..." --red --green --refactored --files "..."] [--exception "..."]' }));
        process.exit(1);
      }
      const tddProviderCfg = tp.getProviderConfig({ skipPrompt: true });
      const ticket = tp.sanitizeTicketIdForPath(tddProviderCfg?.provider === 'github' ? rest[0] : rest[0].toUpperCase(), tddProviderCfg);
      const stepId = rest[1];
      // Parse flags — missing values for --cmd/--files/--exception fall through
      // to recordTddEvidence() validation which returns clear error messages.
      const flags = {};
      for (let i = 2; i < rest.length; i++) {
        if (rest[i] === '--cmd' && rest[i + 1]) { flags.cmd = rest[++i]; }
        else if (rest[i] === '--red') { flags.red = true; }
        else if (rest[i] === '--green') { flags.green = true; }
        else if (rest[i] === '--refactored') { flags.refactored = true; }
        else if (rest[i] === '--files' && rest[i + 1]) { flags.files = rest[++i]; }
        else if (rest[i] === '--exception' && rest[i + 1]) { flags.exception = rest[++i]; }
      }
      let result;
      try {
        result = recordTddEvidence(ticket, stepId, flags);
      } catch (e) {
        console.error(JSON.stringify({ error: 'invalid_path', message: e.message }));
        process.exit(1);
      }
      if (result.error) {
        console.error(JSON.stringify(result));
        process.exit(1);
      }
      console.log(JSON.stringify(result));
      break;
    }
  }
}

main();
