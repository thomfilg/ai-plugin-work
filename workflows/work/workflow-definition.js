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
    } catch {
      return false;
    }
  }

  // GH-215: Helper for STEPS.brief_gate verify. Returns true iff brief.md
  // exists for `ticketId` AND openQuestions.findBlocking(parse(brief)) is
  // empty. Fail-closed on any read/parse error — we never claim verified
  // unless we can prove it. Extracted out of the commandMap entry so the
  // verify declaration reads as a single expression (parallel to
  // `verifyBootstrap` above).
  function verifyBriefGate(ticketId) {
    try {
      const briefPath = path.join(TASKS_BASE, safeTicketPath(ticketId), 'brief.md');
      if (!fs.existsSync(briefPath)) return false;
      const openQuestions = require(path.join(__dirname, 'lib', 'open-questions'));
      const markdown = fs.readFileSync(briefPath, 'utf-8');
      const blocking = openQuestions.findBlocking(openQuestions.parse(markdown));
      return Array.isArray(blocking) && blocking.length === 0;
    } catch {
      return false;
    }
  }

  // GH-253: Helper for STEPS.spec_gate verify. Returns true iff spec.md
  // exists AND (skip override is present OR parse() + validate() passes).
  // Fail-closed: returns false when spec.md is missing or on any error.
  function verifySpecGate(ticketId) {
    try {
      const specPath = path.join(TASKS_BASE, safeTicketPath(ticketId), 'spec.md');
      if (!fs.existsSync(specPath)) return false; // GH-253: fail-closed — missing spec blocks the gate
      const parseGherkin = require(path.join(__dirname, 'lib', 'parse-gherkin'));
      const markdown = fs.readFileSync(specPath, 'utf-8');
      const skipResult = parseGherkin.hasSkipOverride(markdown);
      if (skipResult.skip) return true;
      const parsed = parseGherkin.parse(markdown);
      const validation = parseGherkin.validate(parsed);
      return validation.valid && parsed.errors.length === 0;
    } catch {
      return false;
    }
  }
  // GH-244: verifySpecGate tests added in workflow-definition.test.js

  // GH-259 Task 7.2: Helper to verify per-task TDD evidence when tasks.md exists.
  // Returns true if no tasks.md, or if every taskN/ dir has valid tdd-phase.json.
  // Uses validateTddEvidence from tdd-enforcement.js (single source of truth).
  function verifyPerTaskTDD(ticketId) {
    try {
      const { validateTddEvidence } = require(path.join(__dirname, 'tdd-enforcement'));
      const taskParser = require(path.join(__dirname, 'task-parser'));
      const dir = path.join(TASKS_BASE, safeTicketPath(ticketId));
      const tasksPath = path.join(dir, 'tasks.md');
      if (!fs.existsSync(tasksPath)) return true; // single-task mode — no per-task check
      const tasks = taskParser.parseTasks(dir);
      if (!tasks || tasks.length === 0) return false; // fail-closed: unparseable tasks.md blocks gate
      const expectedTasks = tasks.filter((t) => !t.isCheckpoint);
      if (expectedTasks.length === 0) return true; // only checkpoint tasks — no TDD evidence needed
      for (const task of expectedTasks) {
        const tddPath = path.join(dir, `task${task.num}`, 'tdd-phase.json');
        if (!fs.existsSync(tddPath)) return false;
        const state = JSON.parse(fs.readFileSync(tddPath, 'utf-8'));
        const validation = validateTddEvidence(state);
        if (!validation.valid) return false;
      } // validated via shared validateTddEvidence (tdd-enforcement.js)
      return true;
    } catch {
      return false;
    }
  }

  // ─── Declarative policy config (GH-206 Task 12) ───────────────────────────
  //
  // Artifact patterns per step — consumed by artifact-archival.js on backward
  // transitions. `complete` has no entry because complete->complete is a
  // self-transition (same index) which does not trigger archival; recovery
  // archival for `complete` is handled by unstick-complete.js directly.
  const archivalPatterns = {
    [STEPS.check]: [/^.*\.check\.md$/],
    [STEPS.pr]: [/^\.pr-update-sha$/, /^\.post-pr-update-sha$/],
  };

  // Evidence requirements per step — consumed by step verify functions and
  // reporters. requiredFiles are plain basenames that must exist; qaReportPattern
  // matches at least one QA report filename; requiredApprovals requires files
  // to exist AND match an approval pattern.
  const evidenceRequirements = {
    [STEPS.check]: {
      requiredFiles: ['code-review.check.md', 'tests.check.md', 'completion.check.md', 'README.md'],
      qaReportPattern: /^qa-.*\.check\.md$/,
    },
    [STEPS.reports]: {
      requiredApprovals: [
        { file: 'tests.check.md', pattern: /Status:\s*APPROVED/i },
        { file: 'code-review.check.md', pattern: /Status:\s*APPROVED/i },
        { file: 'completion.check.md', pattern: /Status:\s*(COMPLETE|APPROVED)/i },
      ],
      qaReportPattern: /^qa-.*\.check\.md$/,
      qaApprovalPattern: /Status:\s*APPROVED/i,
    },
  };

  // Agent-gated writer scripts — consumed by enforce-step-workflow.js Rule 5.
  // Maps script basename to { agents, step }. When a Bash command invokes one
  // of these scripts, the hook verifies the caller is an authorized agent and
  // that the correct workflow step is active.
  const agentGatedScripts = {
    'write-qa-report.js': { agents: ['qa-feature-tester', 'qa-api-tester'], step: STEPS.check },
    'write-tests-report.js': { agents: ['quality-checker'], step: STEPS.check },
    'write-code-review.js': { agents: ['code-checker'], step: STEPS.check },
    'write-completion-report.js': { agents: ['completion-checker'], step: STEPS.check },
    'tdd-phase-state.js': {
      agents: [
        'developer-nodejs-tdd',
        'developer-react-senior',
        'developer-react-ui-architect',
        'developer-devops',
      ],
      step: STEPS.implement,
    },
  };

  const workflow = {
    name: 'work',
    stateFile: '.work-state.json',
    evidenceFile: '.step-evidence.json',
    isActive: (state) => state?.status === 'in_progress',
    steps: WORK_STEPS,
    archivalPatterns,
    evidenceRequirements,
    agentGatedScripts,
    // Soft steps allow transition without evidence -- these are optional or metadata-only steps.
    softSteps: new Set([
      STEPS.ticket, // optional/metadata step
      STEPS.ready,
      STEPS.task_review, // GH-211: advisory per-task review gate (soft — does not block)
      STEPS.reports, // operational steps -- no code changes to enforce
      STEPS.complete, // GH-106: terminal step -- all gates already passed at ci/check/reports
    ]),
    // Tool can be a string or array -- some runtimes emit Agent instead of Task.
    commandMap: [
      { step: STEPS.bootstrap, verify: verifyBootstrap },
      {
        step: STEPS.ticket,
        verify: (ticketId) => {
          // Ticket is proven if the work state file exists and is active for this ticket
          try {
            const stateFile = path.join(TASKS_BASE, safeTicketPath(ticketId), '.work-state.json');
            const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
            return (
              state?.status === 'in_progress' &&
              (state?.ticketId === ticketId || state?.ticketId === safeTicketPath(ticketId))
            );
          } catch {
            return false;
          }
        },
      },
      {
        step: STEPS.brief,
        verify: (ticketId) => {
          try {
            return fs.existsSync(path.join(TASKS_BASE, safeTicketPath(ticketId), 'brief.md'));
          } catch {
            return false;
          }
        },
      },
      {
        // GH-215: Gate between `brief` and `spec`. Verified iff brief.md exists
        // AND every blocking open question (cross-ticket / architectural scope,
        // resolved: false) has been answered.
        step: STEPS.brief_gate,
        verify: verifyBriefGate,
      },
      {
        step: STEPS.spec,
        verify: (ticketId) => {
          // GH-253: spec is always mandatory — no env toggle bypass.
          // safeTicketPath() converts #N -> GH-N via cached config.safeTicketId()
          try {
            return fs.existsSync(path.join(TASKS_BASE, safeTicketPath(ticketId), 'spec.md'));
          } catch {
            return false;
          }
        },
      },
      {
        // GH-253: Gate between `spec` and `tasks`. Verified iff spec.md exists
        // AND (gherkin-skip override is present OR parse() + validate() passes).
        // Fail-closed when spec.md is missing or on any read/parse error.
        step: STEPS.spec_gate,
        verify: verifySpecGate,
      },
      {
        step: STEPS.tasks,
        verify: (ticketId) => {
          // verify remains active -- used by evidence checks
          try {
            return fs.existsSync(path.join(TASKS_BASE, safeTicketPath(ticketId), 'tasks.md'));
          } catch {
            return false;
          } // fail-safe: assume tasks not generated
        },
      }, // verify-only entry; tool-pattern mapping follows on next line
      {
        step: STEPS.tasks,
        tool: 'Skill',
        field: 'skill',
        pattern: /^(work-workflow:)?split-in-tasks$/,
      },
      {
        step: STEPS.implement,
        verify: (ticketId) => {
          // tasks step gating is orchestrator-controlled via DEFER/RUN plan actions
          // Implement is proven if tdd-phase.json has at least one cycle with red + green evidence
          try {
            const state = JSON.parse(
              fs.readFileSync(
                path.join(TASKS_BASE, safeTicketPath(ticketId), 'tdd-phase.json'),
                'utf-8'
              )
            );
            // Exception mode: config-only or mechanical changes that skip TDD
            // Accept both legacy string format and structured { category, reason } format
            if (typeof state.exception === 'string' && state.exception.trim() !== '') return true;
            if (typeof state.exception === 'object' && state.exception !== null) {
              // If exception-validator fails to load, the outer catch returns false (fail-closed)
              const { ALLOWED_CATEGORIES } = require(
                path.join(__dirname, '..', 'work-implement', 'exception-validator')
              );
              const cat = state.exception.category;
              const reason = state.exception.reason;
              return (
                typeof cat === 'string' &&
                ALLOWED_CATEGORIES.includes(cat) &&
                typeof reason === 'string' &&
                reason.trim() !== ''
              );
            }
            if (!Array.isArray(state.cycles) || state.cycles.length === 0) return false;
            // At least one cycle must have both red and green evidence
            return state.cycles.some((c) => c.red && c.green);
          } catch {
            return false;
          }
        },
      },
      {
        step: STEPS.commit,
        verify: (ticketId) => {
          // Commit is proven if HEAD has new commits with ticketId (not empty commits)
          try {
            const { execFileSync } = require('child_process');
            const opts = { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] };
            const shaFile = path.join(TASKS_BASE, safeTicketPath(ticketId), '.last-commit-sha');
            const headSha = execFileSync('git', ['rev-parse', 'HEAD'], opts).trim();

            let baseBranch = 'origin/main';
            try {
              const getBaseBranch = require(
                path.join(__dirname, '..', 'lib', 'config')
              ).getBaseBranch;
              baseBranch = getBaseBranch({ cwd: process.cwd() });
            } catch {
              /* fallback to origin/main */
            }

            // 1. If saved SHA exists and HEAD differs -> new commit was made
            try {
              const savedSha = fs.readFileSync(shaFile, 'utf-8').trim();
              if (savedSha && headSha !== savedSha) {
                // Verify it's not an empty commit (must have file changes)
                const diff = execFileSync(
                  'git',
                  ['diff', '--shortstat', savedSha, headSha],
                  opts
                ).trim();
                if (!diff) return false; // Empty commit -- reject
                fs.writeFileSync(shaFile, headSha);
                return true;
              }
            } catch {
              /* no saved SHA -- first run */
            }

            // 2. No saved SHA -> check for any commits on branch (not on main)
            const log = execFileSync(
              'git',
              ['log', '--oneline', `${baseBranch}..HEAD`],
              opts
            ).trim();
            if (log) {
              // Verify diff vs main is non-empty
              const diff = execFileSync(
                'git',
                ['diff', '--shortstat', baseBranch, 'HEAD'],
                opts
              ).trim();
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
                const diff = execFileSync(
                  'git',
                  ['diff', '--shortstat', baseBranch, 'HEAD'],
                  opts
                ).trim();
                if (diff) {
                  if (process.env.ENFORCE_HOOK_DEBUG) {
                    process.stderr.write(
                      `[enforce-hook] commit verify: branch-name fallback matched (branch=${branch}, ticketId=${ticketId})\n`
                    );
                  }
                  fs.writeFileSync(shaFile, headSha);
                  return true;
                }
              }
            } catch {
              /* detached HEAD or other error -- skip fallback */
            }

            return false;
          } catch {
            return false;
          }
        },
      },
      {
        // GH-211: Per-task review gate. Soft check — advisory, not blocking.
        // Verified iff at least one review artifact (task-review-tests.md or
        // task-review-code.md) exists in the ticket's tasks dir.
        step: STEPS.task_review,
        verify: (ticketId) => {
          try {
            const dir = path.join(TASKS_BASE, safeTicketPath(ticketId));
            return (
              fs.existsSync(path.join(dir, 'task-review-tests.md')) ||
              fs.existsSync(path.join(dir, 'task-review-code.md'))
            );
          } catch {
            return false;
          }
        },
      },
      {
        step: STEPS.check,
        verify: (ticketId) => {
          // Check is proven if all required report files exist.
          // Requirements are sourced from evidenceRequirements[check] (declarative).
          try {
            const dir = path.join(TASKS_BASE, safeTicketPath(ticketId));
            const reqs = evidenceRequirements[STEPS.check];
            const required = reqs?.requiredFiles || [];
            if (!required.every((f) => fs.existsSync(path.join(dir, f)))) return false;
            // At least one QA report must exist when web apps are configured
            const config = require(path.join(__dirname, '..', 'lib', 'config'));
            if (config.webAppNames().length > 0) {
              const files = fs.readdirSync(dir);
              const qaPattern = reqs?.qaReportPattern;
              if (qaPattern && !files.some((f) => qaPattern.test(f))) return false;
            }
            // GH-259: When tasks.md exists, verify per-task TDD evidence
            return verifyPerTaskTDD(ticketId);
          } catch {
            return false;
          }
        },
      },
      { step: STEPS.check, tool: 'Skill', field: 'skill', pattern: /^(work-workflow:)?check$/ },
      {
        step: STEPS.cleanup,
        tool: ['Task', 'Agent'],
        field: 'description',
        pattern: new RegExp(`^${STEPS.cleanup}\\b`, 'i'),
      },
      {
        step: STEPS.cleanup,
        verify: (ticketId) => {
          // Cleanup is proven if no dev tmux session exists for this ticket
          try {
            const { execFileSync } = require('child_process');
            const result = execFileSync('tmux', ['has-session', '-t', `${ticketId}-dev`], {
              encoding: 'utf-8',
              timeout: 3000,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
            return false; // Session still exists -- not cleaned up
          } catch {
            return true;
          } // Exit code 1 = session doesn't exist = cleaned up
        },
      },
      {
        step: STEPS.pr,
        verify: (ticketId) => {
          // PR is proven if an open PR exists for the current branch
          try {
            const { execFileSync } = require('child_process');
            const opts = { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] };

            // Resolve branch to support worktree contexts (GH-191, GH-203)
            // Note: gh pr view uses positional branch arg, not --head flag
            let ghArgs = ['pr', 'view', '--json', 'number,state'];
            try {
              const branch = execFileSync('git', ['branch', '--show-current'], opts).trim();
              if (branch) ghArgs = ['pr', 'view', branch, '--json', 'number,state'];
            } catch {
              /* branch detection failed -- fall back to no branch arg */
            }

            const pr = JSON.parse(execFileSync('gh', ghArgs, opts).trim()); // GH-203: positional arg, not --head
            return pr.number > 0 && pr.state === 'OPEN';
          } catch {
            return false;
          }
        },
      },
      {
        step: STEPS.follow_up,
        verify: (ticketId) => {
          // Single source of truth: delegates to follow-up-pr.js isPRGateReady()
          // which encapsulates CI, reviews, bot-comment dedup, and merge-state checks.
          try {
            const { isPRGateReady } = require(path.join(__dirname, 'scripts', 'follow-up-pr.js'));
            const result = isPRGateReady();
            if (!result.ready) return false;

            // Review accountability: every PR comment must be accounted for.
            // Uses strictCommentCount (fail-closed) instead of reviews array length.
            if (result.strictCommentCount > 0) {
              const accountabilityFile = path.join(
                TASKS_BASE,
                safeTicketPath(ticketId),
                'review-accountability.json'
              );
              if (!fs.existsSync(accountabilityFile)) return false;
              const entries = JSON.parse(fs.readFileSync(accountabilityFile, 'utf-8'));
              if (!Array.isArray(entries) || entries.length < result.strictCommentCount)
                return false;
              // GH-285: userApproval requirement removed per brief resolution —
              // disposition + reason fields are sufficient proof of comment triage.
              const validDispositions = ['addressed', 'acknowledged', 'outdated'];
              if (!entries.every((e) => validDispositions.includes(e.disposition) && e.reason))
                return false;
            }

            return true;
          } catch {
            return false;
          }
        },
      },
      {
        step: STEPS.ready,
        tool: ['Task', 'Agent'],
        field: 'description',
        pattern: new RegExp(`^${STEPS.ready}\\b`, 'i'),
      },
      {
        step: STEPS.ci,
        tool: ['Task', 'Agent'],
        field: 'description',
        pattern: new RegExp(`^${STEPS.ci}\\b`, 'i'),
      },
      {
        step: STEPS.ci,
        verify: () => {
          // Single source of truth: delegates to follow-up-pr.js functions
          try {
            const { getPRInfo, checkCI } = require(
              path.join(__dirname, 'scripts', 'follow-up-pr.js')
            );
            const prInfo = getPRInfo();
            if (!prInfo || !prInfo.number) return false;
            const ci = checkCI(prInfo.number);
            return ci.status === 'passing';
          } catch {
            return false;
          }
        },
      },
      {
        step: STEPS.reports,
        tool: ['Task', 'Agent'],
        field: 'description',
        pattern: new RegExp(`^${STEPS.reports}\\b`, 'i'),
      },
      {
        step: STEPS.reports,
        verify: (ticketId) => {
          // Reports is proven if all required check files exist and show APPROVED/COMPLETE.
          // Requirements are sourced from evidenceRequirements[reports] (declarative).
          try {
            const dir = path.join(TASKS_BASE, safeTicketPath(ticketId));
            const reqs = evidenceRequirements[STEPS.reports];
            const required = reqs?.requiredApprovals || [];
            for (const r of required) {
              const fp = path.join(dir, r.file);
              if (!fs.existsSync(fp)) return false;
              if (!r.pattern.test(fs.readFileSync(fp, 'utf-8'))) return false;
            }
            // At least one QA report must exist and pass
            const qaPattern = reqs?.qaReportPattern;
            const approvalPattern = reqs?.qaApprovalPattern;
            if (!qaPattern || !approvalPattern) return verifyPerTaskTDD(ticketId);
            const files = fs.readdirSync(dir).filter((f) => qaPattern.test(f));
            if (files.length === 0) return false;
            if (
              !files.every((f) => approvalPattern.test(fs.readFileSync(path.join(dir, f), 'utf-8')))
            )
              return false;
            // GH-259: When tasks.md exists, verify per-task TDD evidence
            return verifyPerTaskTDD(ticketId);
          } catch {
            return false;
          }
        },
      },
      {
        step: STEPS.complete,
        tool: ['Task', 'Agent'],
        field: 'description',
        pattern: new RegExp(`^${STEPS.complete}\\b`, 'i'),
      },
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
    {
      basename: 'brief.md',
      step: STEPS.brief,
      agents: ['brief-writer'],
      contentGuard: (content, currentStep) => {
        // Only enforce during the 'brief' step — brief_gate is allowed to resolve questions
        if (currentStep !== STEPS.brief) return { blocked: false };
        try {
          const openQuestions = require(path.join(__dirname, 'lib', 'open-questions'));
          const questions = openQuestions.parse(content);
          const resolvedBlocking = questions.filter(
            (q) => q.resolved && (q.scope === 'cross-ticket' || q.scope === 'architectural')
          );
          if (resolvedBlocking.length > 0) {
            return {
              blocked: true,
              message:
                `BLOCKED: Cannot resolve blocking open questions during the brief step.\n` +
                `Found ${resolvedBlocking.length} resolved architectural/cross-ticket question(s).\n` +
                `Only the brief_gate step (via AskUserQuestion) can resolve blocking questions.\n` +
                `Write the questions with resolved: false and let the brief_gate handle resolution.\n`,
            };
          }
        } catch {
          // fail-open on parse errors
        }
        return { blocked: false };
      },
    },
    { basename: 'spec.md', step: STEPS.spec, agents: ['spec-writer'] },
    { basename: 'tasks.md', step: STEPS.tasks, allowedSteps: [STEPS.task_review], agents: [] },
    { basename: '.last-commit-sha', step: STEPS.commit },
    { basename: 'code-review.check.md', step: STEPS.check, agents: ['code-checker'] },
    { basename: 'tests.check.md', step: STEPS.check, agents: ['quality-checker'] },
    { basename: 'completion.check.md', step: STEPS.check, agents: ['completion-checker'] },
    {
      pattern: /^qa-.*\.check\.md$/,
      step: STEPS.check,
      agents: ['qa-feature-tester', 'qa-api-tester'],
    },
    {
      basename: 'code-review-reply.check.md',
      step: STEPS.check,
      agents: ['developer-nodejs-tdd', 'developer-react-senior', 'developer-devops'],
    },
    { basename: 'review-accountability.json', step: STEPS.follow_up, agents: ['follow-up-pr'] },
  ]; // end artifactRules

  return { workflow, artifactRules };
};
