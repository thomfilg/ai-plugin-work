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
 * Step names (aligned with work-state.js):
 *   1_ticket, 2_bootstrap, 3_implement, 4_quality,
 *   5_commit, 6_check, 7_cleanup, 8_test_enhancement,
 *   9_pr, 10_ready, 11_ci, 12_reports, 13_complete
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { appendAction, loadActions, analyzeActions } = require(path.join(__dirname, '..', 'lib', 'work-actions'));

// ─── Configuration ───────────────────────────────────────────────────────────

const MAIN_WORKTREE_FOLDER = process.env.REPO_NAME || 'app-services-monitoring';
const WORKTREES_BASE = `${process.env.HOME}/worktrees`;
const TASKS_BASE = path.join(WORKTREES_BASE, 'tasks');

// ─── State Machine ───────────────────────────────────────────────────────────
// Ported from the TypeScript pattern: createStatusTransitions + canTransition
// See: IStateMachine.ts, createStatusTransitions.ts, canTransition.ts

/**
 * @param {Array<{source: string, targets: string[]}>} transitions
 * @returns {{[key: string]: string[]}}
 */
function createStatusTransitions(transitions) {
  const statusTransitions = {};
  const definedStates = new Set(transitions.map(t => t.source));

  transitions.forEach(t => {
    statusTransitions[t.source] = t.targets.filter(
      target => definedStates.has(target) && target !== t.source,
    );
  });

  return statusTransitions;
}

/**
 * @param {{[key: string]: string[]}} statusTransitions
 * @returns {(current: string, next: string) => boolean}
 */
function canTransition(statusTransitions) {
  return (currentStatus, newStatus) => {
    const validNext = statusTransitions[currentStatus] || [];
    return validNext.includes(newStatus);
  };
}

// ─── Step Transition Graph ───────────────────────────────────────────────────
//
//  Happy path:  1→2→3→4→5→6→7→8→9→10→11→12→13
//
//  Retry loops (backward edges):
//    6_check     → 3_implement   (check failed, fix code)
//    4_quality   → 3_implement   (quality failed, re-implement)
//    8_test_enh  → 5_commit      (enhanced tests need committing)
//    11_ci       → 3_implement   (CI failed, fix code)
//    11_ci       → 8_test_enh    (coverage failed)
//
//  Skip edges (forward jumps):
//    2_bootstrap → 4_quality     (resume: code exists)
//    2_bootstrap → 5_commit      (resume: code + quality done)
//    2_bootstrap → 6_check       (resume: committed, need check)
//    6_check     → 8_test_enh    (no cleanup needed)

const STEP_TRANSITIONS = createStatusTransitions([
  { source: '1_ticket',            targets: ['2_bootstrap'] },
  { source: '2_bootstrap',         targets: ['3_implement', '4_quality', '5_commit', '6_check'] },
  { source: '3_implement',         targets: ['4_quality'] },
  { source: '4_quality',           targets: ['5_commit', '3_implement'] },
  { source: '5_commit',            targets: ['6_check'] },
  { source: '6_check',             targets: ['7_cleanup', '8_test_enhancement', '3_implement'] },
  { source: '7_cleanup',           targets: ['8_test_enhancement'] },
  { source: '8_test_enhancement',  targets: ['9_pr', '5_commit'] },
  { source: '9_pr',                targets: ['10_ready'] },
  { source: '10_ready',            targets: ['11_ci'] },
  { source: '11_ci',               targets: ['12_reports', '3_implement', '8_test_enhancement'] },
  { source: '12_reports',          targets: ['13_complete'] },
  { source: '13_complete',         targets: [] },
]);

const workflowCanTransition = canTransition(STEP_TRANSITIONS);
const ALL_STEPS = Object.keys(STEP_TRANSITIONS);

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
  if (!workState?.stepStatus) return '1_ticket';
  for (const step of ALL_STEPS) {
    if (workState.stepStatus[step] === 'in_progress') return step;
  }
  for (const step of ALL_STEPS) {
    if (workState.stepStatus[step] !== 'completed') return step;
  }
  return '13_complete';
}

// ─── Reports ─────────────────────────────────────────────────────────────────

const REQUIRED_REPORTS = [
  { file: 'tests.check.md', passPattern: /Status:\s*APPROVED/i },
  { file: 'code-review.check.md', passPattern: /Status:\s*APPROVED/i },
  { file: 'completion.check.md', passPattern: /Status:\s*(COMPLETE|APPROVED)/i },
];

// ─── State Inspection ────────────────────────────────────────────────────────

function inspect(ticket) {
  const s = {};

  s.worktreeDir = path.join(WORKTREES_BASE, `${MAIN_WORKTREE_FOLDER}-${ticket}`);
  s.tasksDir = path.join(TASKS_BASE, ticket);
  s.worktreeExists = fileExists(s.worktreeDir);
  s.tasksDirExists = fileExists(s.tasksDir);

  s.workState = loadWorkState(ticket);
  s.hasStateFile = s.workState !== null;
  s.currentStep = getCurrentStep(s.workState);
  s.stepIs = (step) => s.workState?.stepStatus?.[step] || 'unknown';

  // Git
  if (s.worktreeExists) {
    const c = s.worktreeDir;
    s.branch = run(`git -C "${c}" branch --show-current`);
    s.headSha = run(`git -C "${c}" rev-parse HEAD`);
    const diff = run(`git -C "${c}" diff --shortstat origin/main -- . 2>/dev/null`);
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

  // Test enhancement
  const te = s.workState?.testEnhancement;
  s.testEnhancement = te || null;
  s.testEnhancementDone = s.stepIs('8_test_enhancement') === 'completed' || te?.skipped === true;

  // Dev session
  s.hasDevSession = run(`tmux has-session -t "${ticket}-dev" 2>/dev/null && echo yes`) === 'yes';

  return s;
}

// ─── Plan Generation ─────────────────────────────────────────────────────────

function generatePlan(ticket, description, s, rework) {
  const plan = [];
  const mode = rework ? 'rework' : 'resume';
  const t = ticket || '{TICKET}';
  const worktreeDir = s?.worktreeDir || `${WORKTREES_BASE}/${MAIN_WORKTREE_FOLDER}-${t}`;
  const tasksDir = s?.tasksDir || `${TASKS_BASE}/${t}`;

  function add(stepName, action, command, reason, extra = {}) {
    plan.push({ step: stepName, action, ...(command ? { command } : {}), reason, ...extra });
  }

  // 1_ticket
  if (!ticket) {
    add('1_ticket', 'RUN', 'Task(jira-task-creator)', `Create ticket from: "${description}"`, {
      agentType: 'jira-task-creator',
      agentPrompt: `Create a Jira ticket from this description: "${description}"`,
    });
  } else {
    add('1_ticket', 'RUN', 'Task(general-purpose)', 'Fetch ticket details', {
      agentType: 'general-purpose',
      agentPrompt: `Fetch Jira ticket ${ticket} using mcp__atlassian__jira_get_issue with issue_key "${ticket}". Return the ticket summary, description, status, and acceptance criteria.`,
    });
  }

  // 2_bootstrap
  if (s?.worktreeExists && s?.pr) {
    add('2_bootstrap', 'SKIP', null, `Worktree + PR #${s.pr.number} exist`);
  } else if (s?.worktreeExists) {
    add('2_bootstrap', 'RUN', `/bootstrap ${ticket}`, 'Worktree exists but no PR', {
      agentType: 'skill',
      agentPrompt: `/bootstrap ${ticket}`,
    });
  } else {
    add('2_bootstrap', 'RUN', `/bootstrap ${t}`, 'No worktree found', {
      agentType: 'skill',
      agentPrompt: `/bootstrap ${t}`,
    });
  }

  add('2b_transition', 'RUN',
    'Task(general-purpose)',
    'Jira → In Development (idempotent)', {
      agentType: 'general-purpose',
      agentPrompt: `Transition Jira ticket ${t} to "In Development" (idempotent). Use mcp__atlassian__jira_get_transitions to get available transitions for ${t}, then use mcp__atlassian__jira_transition_issue to move it to "In Development" (or similar active status). If already in that status, report success.`,
    });

  // 3_implement
  if (s?.hasDiffVsMain) {
    add('3_implement', 'SKIP', null, `Changes exist: ${s.diffSummary}`);
  } else {
    add('3_implement', 'RUN', '/work-implement <requirements>', 'No changes vs main', {
      agentType: 'skill',
      agentPrompt: '/work-implement <requirements>',
    });
  }

  // 4_quality
  if (s?.hasDiffVsMain && s?.stepIs('4_quality') === 'completed') {
    add('4_quality', 'SKIP', null, 'Previously passed');
  } else if (!s?.hasDiffVsMain) {
    add('4_quality', 'PENDING', null, 'Depends on 3_implement');
  } else {
    add('4_quality', 'RUN', 'Task(quality-checker)', 'Lint + typecheck + test', {
      agentType: 'quality-checker',
      agentPrompt: `Run quality checks in ${worktreeDir}:\npnpm dev:check\n\nReturn PASS or FAIL with summary.`,
    });
  }

  // 5_commit
  if (s?.hasUncommitted) {
    add('5_commit', 'RUN', 'Task(commit-writer)', `${s.uncommittedCount} uncommitted file(s)`, {
      agentType: 'commit-writer',
      agentPrompt: `autonomous - commit staged changes for ${t}`,
    });
  } else if (s?.hasCommitWithTicket) {
    add('5_commit', 'SKIP', null, `Latest: "${s.lastCommitMsg}"`);
  } else if (!s?.hasDiffVsMain) {
    add('5_commit', 'PENDING', null, 'Depends on 3_implement');
  } else {
    add('5_commit', 'RUN', 'Task(commit-writer)', 'Commit missing ticket ID', {
      agentType: 'commit-writer',
      agentPrompt: `autonomous - commit staged changes for ${t}`,
    });
  }

  // 6_check
  if (rework) {
    add('6_check', 'RUN', '/check', 'REWORK: Always re-run', {
      agentType: 'skill',
      agentPrompt: '/check',
      preCommands: [
        `rm -f "${tasksDir}"/*.check.md`,
        `rm -f "${tasksDir}"/.pr-update-sha`,
        `rm -f "${tasksDir}"/.post-pr-update-sha`,
      ],
    });
  } else if (s?.allReportsPass && Object.keys(s.reports).length >= 3) {
    add('6_check', 'SKIP', null, `RESUME: All ${Object.keys(s.reports).length} reports PASS`);
  } else {
    const p = [];
    if (s?.missingReports?.length) p.push(`missing: ${s.missingReports.join(', ')}`);
    if (s?.failedReports?.length) p.push(`failed: ${s.failedReports.join(', ')}`);
    add('6_check', 'RUN', '/check', p.length ? p.join('; ') : 'No reports found', {
      agentType: 'skill',
      agentPrompt: '/check',
    });
  }

  // 7_cleanup
  if (s?.hasDevSession) {
    add('7_cleanup', 'RUN', `Task(Bash)`, 'Dev session running', {
      agentType: 'Bash',
      agentPrompt: `Run: tmux kill-session -t "${ticket}-dev" 2>/dev/null; echo "Cleanup done"`,
    });
  } else {
    add('7_cleanup', 'SKIP', null, 'No dev session');
  }

  // 8_test_enhancement
  if (rework) {
    add('8_test_enhancement', 'RUN', `Skill(test-coordination): ${ticket}`, 'REWORK: Re-run', {
      agentType: 'skill',
      agentPrompt: `/test-coordination ${ticket}`,
    });
  } else if (s?.testEnhancementDone) {
    const te = s.testEnhancement;
    const d = te?.skipped ? `Skipped: ${te.skipReason || '?'}` : `Rating ${te?.finalRating || '?'}/10`;
    add('8_test_enhancement', 'SKIP', null, d);
  } else {
    add('8_test_enhancement', 'RUN', `Skill(test-coordination): ${t}`, 'Not yet run', {
      agentType: 'skill',
      agentPrompt: `/test-coordination ${t}`,
    });
  }

  // 9_pr
  if (rework) {
    add('9_pr', 'RUN', `/work-pr ${ticket} --force`, 'REWORK: Force update', {
      agentType: 'skill',
      agentPrompt: `/work-pr ${ticket} --force`,
    });
  } else if (s?.prShaMatch && s?.prEverUpdated) {
    add('9_pr', 'SKIP', null, `SHA match (${s.headSha?.substring(0, 8)})`);
  } else if (s?.prEverUpdated) {
    add('9_pr', 'RUN', `/work-pr ${ticket}`, `HEAD: ${s.prUpdateSha?.substring(0, 8) || '?'} → ${s.headSha?.substring(0, 8) || '?'}`, {
      agentType: 'skill',
      agentPrompt: `/work-pr ${ticket}`,
    });
  } else {
    add('9_pr', 'RUN', `/work-pr ${t}`, 'Must run once', {
      agentType: 'skill',
      agentPrompt: `/work-pr ${t}`,
    });
  }

  // 10_ready
  if (s?.pr && !s.pr.isDraft) {
    add('10_ready', 'SKIP', null, 'Already ready');
  } else {
    add('10_ready', 'RUN', 'Task(Bash)', 'Mark PR ready', {
      agentType: 'Bash',
      agentPrompt: `Run in ${worktreeDir}: gh pr ready`,
    });
  }

  // 11_ci → 13_complete
  add('11_ci', 'RUN', 'Task(Bash)', 'Wait for CI', {
    agentType: 'Bash',
    agentPrompt: `Run in ${worktreeDir}: gh pr checks --watch --interval 60\n\nReturn PASS if all checks pass, FAIL with details if any fail.`,
  });
  add('12_reports', 'RUN', 'Task(Bash)', 'Move reports to tasks/', {
    agentType: 'Bash',
    agentPrompt: `Verify and consolidate reports in ${tasksDir}. List all *.check.md files and confirm they exist. Report the count and status of each.`,
  });
  add('13_complete', 'RUN', 'Task(Bash)', 'Finish', {
    agentType: 'Bash',
    agentPrompt: `Run: node ~/.claude/hooks/work-state.js complete ${t}`,
  });

  return { ticket: ticket || `TBD ("${description}")`, mode, plan };
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

  // Initialize state if needed
  if (!ws) {
    ws = {
      ticketId: ticket, description: '', currentStep: 1, status: 'in_progress',
      stepStatus: {}, checkProgress: {},
      testEnhancement: { initialRating: 0, finalRating: 0, iterations: 0, skipped: false, skipReason: null },
      errors: [], startTime: new Date().toISOString(), lastUpdate: new Date().toISOString(),
    };
    ALL_STEPS.forEach(s => { ws.stepStatus[s] = 'pending'; });
    appendAction(ticket, { step: '1_ticket', what: 'workflow started' });
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
    // Going backward (retry loop) — reset intermediate steps to pending
    for (let i = targetIdx + 1; i <= currentIdx; i++) {
      ws.stepStatus[ALL_STEPS[i]] = 'pending';
      appendAction(ticket, { step: ALL_STEPS[i], what: 'step reset' });
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

  const subcommands = ['plan', 'transition', 'transitions', 'graph', 'actions'];
  const command = subcommands.includes(args[0]) ? args[0] : 'plan';
  const rest = subcommands.includes(args[0]) ? args.slice(1) : args;

  switch (command) {
    case 'plan': {
      const rework = rest.includes('--rework');
      const raw = rest.filter(a => a !== '--rework').join(' ').trim();
      if (!raw) { console.log(JSON.stringify({ error: true, message: 'Provide ticket ID or description' })); process.exit(1); }
      const isTicket = /^[A-Z]+-\d+$/i.test(raw);
      const ticket = isTicket ? raw.toUpperCase() : null;
      const state = ticket ? inspect(ticket) : null;
      const result = generatePlan(ticket, isTicket ? null : raw, state, rework);

      result.timestamp = new Date().toISOString();
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
          testEnhancement: state.testEnhancement, testEnhancementDone: state.testEnhancementDone,
          hasDevSession: state.hasDevSession, workStateStatus: state.workState?.status || null,
        };
      }
      const by = (a) => result.plan.filter(s => s.action === a);
      result.summary = {
        total: result.plan.length, run: by('RUN').length, skip: by('SKIP').length, pending: by('PENDING').length,
        firstAction: by('RUN')[0]?.step || 'none',
        stepsToRun: by('RUN').map(s => s.step), stepsSkipped: by('SKIP').map(s => s.step),
      };
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'transition': {
      if (rest.length < 2) {
        console.log(JSON.stringify({ error: true, message: 'Usage: transition <TICKET> <step>', validSteps: ALL_STEPS }));
        process.exit(1);
      }
      console.log(JSON.stringify(transitionStep(rest[0].toUpperCase(), rest[1]), null, 2));
      break;
    }

    case 'transitions': {
      if (!rest[0]) { console.log(JSON.stringify({ error: true, message: 'Usage: transitions <TICKET>' })); process.exit(1); }
      console.log(JSON.stringify(getAvailableTransitions(rest[0].toUpperCase()), null, 2));
      break;
    }

    case 'graph': {
      console.log(JSON.stringify({ steps: ALL_STEPS, transitions: STEP_TRANSITIONS }, null, 2));
      break;
    }

    case 'actions': {
      if (!rest[0]) {
        console.log(JSON.stringify({ error: true, message: 'Usage: actions <TICKET> [--raw]' }));
        process.exit(1);
      }
      const ticket = rest[0].toUpperCase();
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
  }
}

main();
