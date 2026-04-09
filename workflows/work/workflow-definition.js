/**
 * workflows/work/workflow-definition.js
 *
 * Work workflow definition -- extracted from enforce-step-workflow.js
 * for auto-discovery. Follows Open/Closed Principle: add new workflows
 * by creating workflow-definition.js in their directory.
 */

const path = require('path');
const fs = require('fs');
const { STEPS, ALL_STEPS: WORK_STEPS } = require(path.join(__dirname, 'step-registry'));

/**
 * @param {Object} deps - Shared dependencies injected by enforce-step-workflow
 * @param {string} deps.TASKS_BASE - Tasks base directory
 * @param {Function} deps.safeTicketPath - Ticket ID sanitizer
 * @param {Function} deps.resolveGitHead - Git HEAD resolver
 * @returns {{ workflow: Object, artifactRules: Array }}
 */
module.exports = function createWorkflowDefinition({ TASKS_BASE, safeTicketPath, resolveGitHead }) {

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

  const workflow = {
    name: 'work',
    stateFile: '.work-state.json',
    evidenceFile: '.step-evidence.json',
    isActive: (state) => state?.status === 'in_progress',
    steps: WORK_STEPS,
    // Soft steps allow transition without evidence -- these are optional or metadata-only steps.
    softSteps: new Set([
      STEPS.ticket,                           // optional/metadata step
      STEPS.ready, STEPS.reports,             // operational steps -- no code changes to enforce
      STEPS.complete,                         // GH-106: terminal step -- all gates already passed at ci/check/reports
    ]),
    // Tool can be a string or array -- some runtimes emit Agent instead of Task.
    commandMap: [
      { step: STEPS.bootstrap, verify: verifyBootstrap },
      { step: STEPS.ticket, verify: (ticketId) => {
        // Ticket is proven if the work state file exists and is active for this ticket
        try {
          const stateFile = path.join(TASKS_BASE, safeTicketPath(ticketId), '.work-state.json');
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          return state?.status === 'in_progress' && (state?.ticketId === ticketId || state?.ticketId === safeTicketPath(ticketId));
        } catch { return false; }
      }},
      { step: STEPS.brief, verify: (ticketId) => {
        try { return fs.existsSync(path.join(TASKS_BASE, safeTicketPath(ticketId), 'brief.md')); }
        catch { return false; }
      }},
      { step: STEPS.spec, verify: (ticketId) => {
        // safeTicketPath() converts #N -> GH-N via cached config.safeTicketId()
        try { return fs.existsSync(path.join(TASKS_BASE, safeTicketPath(ticketId), 'spec.md')); }
        catch { return false; }
      }},
      { step: STEPS.tasks, verify: (ticketId) => { // verify remains active -- used by evidence checks
        try { return fs.existsSync(path.join(TASKS_BASE, safeTicketPath(ticketId), 'tasks.md')); }
        catch { return false; } // fail-safe: assume tasks not generated
      }}, // verify-only entry; tool-pattern mapping follows on next line
      { step: STEPS.tasks, tool: 'Skill', field: 'skill', pattern: /^(work-workflow:)?split-in-tasks$/ },
      { step: STEPS.implement, verify: (ticketId) => { // tasks step gating is orchestrator-controlled via SKIP/RUN plan actions
        // Implement is proven if tdd-phase.json has at least one cycle with red + green evidence
        try {
          const state = JSON.parse(fs.readFileSync(
            path.join(TASKS_BASE, safeTicketPath(ticketId), 'tdd-phase.json'), 'utf-8'
          ));
          // Exception mode: config-only or mechanical changes that skip TDD
          if (typeof state.exception === 'string' && state.exception.trim() !== '') return true;
          if (!Array.isArray(state.cycles) || state.cycles.length === 0) return false;
          // At least one cycle must have both red and green evidence
          return state.cycles.some(c => c.red && c.green);
        } catch { return false; }
      }},
      { step: STEPS.commit, verify: (ticketId) => {
        // Commit is proven if HEAD has new commits with ticketId (not empty commits)
        try {
          const { execFileSync } = require('child_process');
          const opts = { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] };
          const shaFile = path.join(TASKS_BASE, safeTicketPath(ticketId), '.last-commit-sha');
          const headSha = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim();

          let baseBranch = 'origin/main';
          try {
            const getBaseBranch = require(path.join(__dirname, '..', 'lib', 'config')).getBaseBranch;
            baseBranch = getBaseBranch({ cwd: process.cwd() });
          } catch { /* fallback to origin/main */ }

          // 1. If saved SHA exists and HEAD differs -> new commit was made
          try {
            const savedSha = fs.readFileSync(shaFile, 'utf-8').trim();
            if (savedSha && headSha !== savedSha) {
              // Verify it's not an empty commit (must have file changes)
              const diff = execFileSync('git', ['diff', '--shortstat', savedSha, headSha], opts).trim();
              if (!diff) return false; // Empty commit -- reject
              fs.writeFileSync(shaFile, headSha);
              return true;
            }
          } catch { /* no saved SHA -- first run */ }

          // 2. No saved SHA -> check for any commits on branch (not on main)
          const log = execFileSync('git', ['log', '--oneline', `${baseBranch}..HEAD`], opts).trim();
          if (log) {
            // Verify diff vs main is non-empty
            const diff = execFileSync('git', ['diff', '--shortstat', baseBranch, 'HEAD'], opts).trim();
            if (!diff) return false; // No actual changes -- reject
            fs.writeFileSync(shaFile, headSha);
            return true;
          }

          // 3. Branch-name fallback: branch contains ticketId + committed changes exist (GH-191)
          try {
            const branch = execFileSync('git', ['branch', '--show-current'], opts).trim();
            const escapedTicketId = ticketId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const branchTicketPattern = new RegExp(`(?:^|[/-])${escapedTicketId}(?:$|[/-])`);
            if (branch && branchTicketPattern.test(branch)) {
              const diff = execFileSync('git', ['diff', '--shortstat', baseBranch, 'HEAD'], opts).trim();
              if (diff) {
                if (process.env.ENFORCE_HOOK_DEBUG) {
                  process.stderr.write(`[enforce-hook] commit verify: branch-name fallback matched (branch=${branch}, ticketId=${ticketId})\n`);
                }
                fs.writeFileSync(shaFile, headSha);
                return true;
              }
            }
          } catch { /* detached HEAD or other error -- skip fallback */ }

          return false;
        } catch { return false; }
      }},
      { step: STEPS.check, verify: (ticketId) => {
        // Check is proven if all required report files exist
        try {
          const dir = path.join(TASKS_BASE, safeTicketPath(ticketId));
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
          return false; // Session still exists -- not cleaned up
        } catch { return true; } // Exit code 1 = session doesn't exist = cleaned up
      }},
      { step: STEPS.pr, verify: (ticketId) => {
        // PR is proven if an open PR exists for the current branch
        try {
          const { execFileSync } = require('child_process');
          const opts = { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] };

          // Resolve branch for --head flag to support worktree contexts (GH-191)
          let ghArgs = ['pr', 'view', '--json', 'number,state'];
          try {
            const branch = execFileSync('git', ['branch', '--show-current'], opts).trim();
            if (branch) ghArgs = ['pr', 'view', '--head', branch, '--json', 'number,state'];
          } catch { /* detached HEAD -- fall back to no --head */ }

          const pr = JSON.parse(execFileSync('gh', ghArgs, opts).trim());
          return pr.number > 0 && pr.state === 'OPEN';
        } catch { return false; }
      }},
      { step: STEPS.follow_up, verify: (ticketId) => {
        // Verify follow_up by checking LIVE GitHub state -- no fakeable state files.
        // Checks: CI passing, no changes-requested reviews, all PR comments accounted for.
        try {
          const { execFileSync } = require('child_process');
          const opts = { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] };

          // Resolve branch once for --head flag to support worktree contexts (GH-191)
          let prViewArgs = ['pr', 'view', '--json', 'number', '-q', '.number'];
          try {
            const branch = execFileSync('git', ['branch', '--show-current'], opts).trim();
            if (branch) prViewArgs = ['pr', 'view', '--head', branch, '--json', 'number', '-q', '.number'];
          } catch { /* detached HEAD -- fall back to no --head */ }

          // 1. Get PR number
          const prNum = execFileSync('gh', prViewArgs, opts).trim();
          if (!prNum) return false;

          // 2. CI checks must all pass (or have no checks)
          const checksJson = execFileSync('gh', ['pr', 'checks', prNum, '--json', 'state,name'], opts).trim();
          const checks = JSON.parse(checksJson || '[]');
          const badStates = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'ACTION_REQUIRED', 'PENDING', 'STARTUP_FAILURE']);
          if (checks.some(c => badStates.has(c.state))) return false;

          // 3. No blocking reviews (CHANGES_REQUESTED)
          const reviewJson = execFileSync('gh', ['pr', 'view', prNum, '--json', 'reviewDecision'], opts).trim();
          const reviewData = JSON.parse(reviewJson || '{}');
          if (reviewData.reviewDecision === 'CHANGES_REQUESTED') return false;

          // 4. Review accountability: every PR comment must be accounted for
          const commentCount = parseInt(
            execFileSync('gh', ['api', `repos/{owner}/{repo}/pulls/${prNum}/comments`, '--jq', 'length'], opts).trim(),
            10
          );
          if (commentCount > 0) {
            const accountabilityFile = path.join(TASKS_BASE, safeTicketPath(ticketId), 'review-accountability.json');
            if (!fs.existsSync(accountabilityFile)) return false;
            const entries = JSON.parse(fs.readFileSync(accountabilityFile, 'utf-8'));
            if (!Array.isArray(entries) || entries.length < commentCount) return false;
            if (!entries.every(e => e.disposition && e.reason)) return false;
            // "acknowledged" entries require user approval via AskUserQuestion
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
          const dir = path.join(TASKS_BASE, safeTicketPath(ticketId));
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
      // GH-106: Removed strict verify gate for complete step. CI/PR checks are
      // already enforced at the ci and check steps. The complete step is a soft
      // step, so no verify function is needed. This prevents deadlocks when CI
      // re-runs or PR state changes transiently after reaching the terminal step.
    ],
    transitionPattern: /work(?:-orchestrator|.workflow)\.js\s+transition\s+(\S+)\s+(\S+)/,
    exemptPatterns: [
      /work(?:-orchestrator|.workflow)\.js\s+(plan|transitions|graph)/,
      /work-state\.js\s+(get|resume-info|init|task-current|task-advance|task-get|task-init)/,
    ],
    transitionHint: `node ${path.join(__dirname, 'work.workflow.js')} transition`,
  };

  const artifactRules = [
    { basename: 'brief.md',          step: STEPS.brief, agents: ['brief-writer'] },
    { basename: 'spec.md',           step: STEPS.spec,  agents: ['spec-writer'] },
    { basename: 'tasks.md',          step: STEPS.tasks, agents: [] },
    { basename: '.last-commit-sha',  step: STEPS.commit },
    { basename: 'code-review.check.md',  step: STEPS.check, agents: ['code-checker'] },
    { basename: 'tests.check.md',        step: STEPS.check, agents: ['quality-checker'] },
    { basename: 'completion.check.md',   step: STEPS.check, agents: ['completion-checker'] },
    { pattern: /^qa-.*\.check\.md$/,     step: STEPS.check, agents: ['qa-feature-tester', 'qa-api-tester'] },
    { basename: 'code-review-reply.check.md', step: STEPS.check, agents: ['developer-nodejs-tdd', 'developer-react-senior', 'developer-devops'] },
    { basename: 'review-accountability.json', step: STEPS.follow_up, agents: ['follow-up-pr'] },
  ]; // end artifactRules

  return { workflow, artifactRules };
};
