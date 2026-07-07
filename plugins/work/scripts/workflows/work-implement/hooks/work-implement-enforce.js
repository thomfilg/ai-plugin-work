#!/usr/bin/env node

/**
 * PreToolUse hook to enforce agent usage during /work-implement command.
 *
 * Registered in plugins/work/hooks/hooks.json under PreToolUse with matcher
 * `Edit|Write|MultiEdit`, after the protect-* hooks (W1, implement-phase fix
 * design). Fail-open by design when no workflow/implement step is active:
 * missing ticket id, no enforcement context, or implement not in_progress
 * all exit 0 without blocking.
 *
 * GH-219 Task 14: Rewritten for state-based activation via
 * loadEnforcementContext (R1). No transcript grep for implement-active
 * detection. Uses isWriteAllowedPath from Task 12 (R6, R12). Injects
 * appendEnforcementAudit for audit records (R13). TDD phase resolution
 * via allocator per-task path with legacy fallback (R7, R8).
 *
 * When /work-implement is active (state: implement step in_progress),
 * blocks direct Write/Edit operations unless a developer-* agent has
 * been invoked first.
 */

const fs = require('fs');
const path = require('path');
const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));
// Vendored dual-runtime adapter: runtime detection (per-runtime block text),
// apply_patch target parsing, and the dual-format transcript reader for the
// developer-invocation scan.
const { getRuntime } = require(path.join(__dirname, '..', '..', 'lib', 'runtime'));
const { parseApplyPatch } = require(path.join(__dirname, '..', '..', 'lib', 'runtime', 'tools'));
const { sniffFormat, readToolEvents } = require(
  path.join(__dirname, '..', '..', 'lib', 'runtime', 'transcript')
);

// --- Task 12 import: task-readiness path gate (R6, R12) ---
const { isWriteAllowedPath } = require(path.join(__dirname, '..', '..', 'lib', 'preflight'));
const { taskSegment } = require(path.join(__dirname, '..', '..', 'lib', 'allocate-output-folder'));
// Shared `<WORKTREES_BASE>/<repo>-<ticket>` lookup (same module the
// enforce-tdd-on-stop hook uses — keeps the two hooks from drifting).
const { conventionWorktreeDir } = require(path.join(__dirname, 'worktree-convention'));

// Developer agents that satisfy the requirement
const DEVELOPER_AGENTS = [
  'developer-nodejs-tdd',
  'developer-react-senior',
  'developer-react-ui-architect',
  'developer-devops',
  ...(process.env.WORK_ARCHITECT_ENABLED === '1' ? ['code-architect'] : []),
];

// Tools that require agent invocation first
const BLOCKED_TOOLS = ['Write', 'Edit', 'MultiEdit'];

// Files that are allowed without agent (config, non-code files)
const ALLOWED_PATTERNS = [
  /\.md$/, // Markdown files
  /\.json$/, // JSON config files
  /\.ya?ml$/, // YAML files
  /\.env/, // Environment files
  /\.gitignore$/, // Git ignore
  /\.eslintrc/, // ESLint config
  /\.prettierrc/, // Prettier config
  /package\.json$/, // Package files
  /tsconfig/, // TypeScript config
  /\/\.claude\//, // Files in .claude folder (hooks, commands, agents)
  /\/__tests__\//, // Test directories
  /\.test\.[jt]sx?$/, // .test.js, .test.ts, .test.tsx
  /\.spec\.[jt]sx?$/, // .spec.js, .spec.ts, .spec.tsx
  /work-implement-enforce\.js$/, // This file specifically
];

// ─── State-based activation (GH-219 R1) ──────────────────────────────────

/**
 * Determine if the implement step is active using canonical state.
 * Replaces transcript-based isWorkImplementActive.
 *
 * Returns true when:
 *   - workflow is active (status === 'in_progress')
 *   - implement step is 'in_progress'
 *
 * @param {object} ctx - EnforcementContext from loadEnforcementContext
 * @returns {boolean}
 */
function isImplementActive(ctx) {
  if (!ctx || !ctx.hasWorkflow) return false;
  const state = ctx.state;
  if (!state || state.status !== 'in_progress') return false;
  const stepStatus = state.stepStatus || {};
  return stepStatus.implement === 'in_progress';
}

/**
 * Payload-first developer identification (design C12): when the hook fires
 * inside a subagent, the payload's `agent_type` names it on both runtimes —
 * codex sets no CLAUDE_* env vars and its rollout transcript is unreadable
 * by the claude scan below.
 */
function payloadIsDeveloperAgent(hookData) {
  const agentType = String(hookData?.agent_type || '')
    .replace(/^[\w-]+:/, '')
    .toLowerCase();
  if (!agentType) return false;
  return DEVELOPER_AGENTS.some((agent) => agent.toLowerCase() === agentType);
}

/** Matches an inline persona adoption: a shell read of agents/developer-*.md. */
const CODEX_PERSONA_READ_RE = /agents\/(?:[\w-]+:)?(?:developer-[\w-]+|code-architect)\.md/;

/**
 * Codex leg of the developer-invocation scan: the rollout transcript has no
 * Task tool_use records. Count either a spawn_agent dispatch naming a
 * developer agent (TUI escape hatch) or an inline persona adoption — a shell
 * command reading a developer agents/*.md file (design C1: subagents run
 * INLINE on codex; reading the persona file is the observable dispatch).
 */
function codexDeveloperInvocation(transcriptPath) {
  try {
    for (const event of readToolEvents(transcriptPath)) {
      const input = JSON.stringify(event.input || '');
      if (event.rawName === 'spawn_agent' && /developer-/i.test(input)) return true;
      if (event.name === 'Bash' && CODEX_PERSONA_READ_RE.test(input)) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Check if a developer agent has been invoked (transcript-based).
 * This remains transcript-based because agent invocation is a session-level
 * signal, not a persisted state. The claude scan is byte-for-byte the
 * historical one; codex rollouts route through the vendored reader.
 */
function hasDeveloperAgentBeenInvoked(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return false;
  }

  if (sniffFormat(transcriptPath) === 'codex') {
    return codexDeveloperInvocation(transcriptPath);
  }

  try {
    const content = fs.readFileSync(transcriptPath, 'utf8');

    // Check if any developer agent has been called via Task tool
    for (const agent of DEVELOPER_AGENTS) {
      const pattern = new RegExp(`"subagent_type"\\s*:\\s*"(work-workflow:)?${agent}"`, 'i');
      if (pattern.test(content)) {
        return true;
      }
    }

    // Also check if we're currently INSIDE a developer agent
    for (const agent of DEVELOPER_AGENTS) {
      const frontmatterPattern = new RegExp(`^name:\\s*${agent}`, 'm');
      if (frontmatterPattern.test(content)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Check if the file being edited is allowed without agent
 */
function isFileAllowed(filePath) {
  if (!filePath) return false;
  return ALLOWED_PATTERNS.some((pattern) => pattern.test(filePath));
}

/**
 * Resolve TASKS_BASE from environment or config.
 * Shared by checkTddPhase and the R6 path gate.
 */
function resolveTaskBase() {
  let taskBase;
  try {
    const cfg = require(path.join(__dirname, '..', '..', 'lib', 'config'));
    taskBase = process.env.TASKS_BASE || cfg.TASKS_BASE || null;
  } catch {
    taskBase = process.env.TASKS_BASE || null;
  }
  if (!taskBase) {
    taskBase =
      process.env.HOME || process.env.USERPROFILE
        ? path.join(process.env.HOME || process.env.USERPROFILE, 'worktrees', 'tasks')
        : null;
  }
  return taskBase;
}

/**
 * Sanitize a ticket ID via config.safeTicketId if available.
 * Shared by checkTddPhase and the R6 path gate.
 */
function resolveSafeTicketId(ticketId) {
  try {
    return require(path.join(__dirname, '..', '..', 'lib', 'config')).safeTicketId(ticketId);
  } catch {
    return ticketId;
  }
}

/**
 * Resolve the TDD phase state path with per-task support (R7, R8).
 *
 * When WORK_TASK_NUM is set:
 *   - Try per-task path first: TASKS_BASE/<ticket>/task${N}/tdd-phase.json
 *   - Fall back to legacy root: TASKS_BASE/<ticket>/tdd-phase.json
 *
 * When WORK_TASK_NUM is NOT set:
 *   - Use legacy root path
 *
 * @param {string} taskBase - Resolved TASKS_BASE
 * @param {string} safeTicketId - Sanitized ticket ID
 * @returns {string|null} Path to tdd-phase.json, or null if not found
 */
function resolveTddStatePath(taskBase, safeTicketId) {
  // Resolve task number: env var → work state tasksMeta → null (legacy)
  const taskNum = resolveActiveTaskNum(taskBase, safeTicketId);

  if (taskNum) {
    // Try per-task path first
    let segment;
    try {
      segment = taskSegment(taskNum);
    } catch {
      segment = `task${taskNum}`;
    }
    const perTaskPath = path.join(taskBase, safeTicketId, segment, 'tdd-phase.json');
    if (fs.existsSync(perTaskPath)) {
      return perTaskPath;
    }
  }

  // Legacy root fallback
  const rootPath = path.join(taskBase, safeTicketId, 'tdd-phase.json');
  if (fs.existsSync(rootPath)) {
    return rootPath;
  }

  return null;
}

/**
 * Read the configured task number: WORK_TASK_NUM env var, falling back to
 * the work state's tasksMeta.currentTaskIndex. Returns the RAW value
 * (number | NaN | null) — buildAllowedPaths needs the null-vs-invalid
 * distinction to fail closed on a malformed WORK_TASK_NUM.
 */
function readConfiguredTaskNum(taskBase, safeTicketId) {
  let taskNum = process.env.WORK_TASK_NUM ? parseInt(process.env.WORK_TASK_NUM, 10) : null;
  if (!taskNum) {
    try {
      const statePath = path.join(taskBase, safeTicketId, '.work-state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state?.tasksMeta?.currentTaskIndex != null) {
        taskNum = state.tasksMeta.currentTaskIndex + 1; // 0-indexed → 1-indexed
      }
    } catch {
      /* no state file */
    }
  }
  return taskNum;
}

/**
 * Resolve the active task number as a validated positive integer, or null.
 */
function resolveActiveTaskNum(taskBase, safeTicketId) {
  const taskNum = readConfiguredTaskNum(taskBase, safeTicketId);
  return Number.isInteger(taskNum) && taskNum > 0 ? taskNum : null;
}

/**
 * GH-570 (W1×W8): during RED, a task whose planner-declared `### Test
 * Strategy` carries `red-mode: ablation` produces its failing RED by
 * TEMPORARILY mutating in-scope SOURCE files — the registry's "only .test
 * or .spec files during RED" rule would deadlock it. The allowance is
 * machine-verified from planner-owned tasks.md via the SHARED
 * implement-gate resolver (resolveTaskTestExecution — the same module the
 * gate, the stop hook, and task-next.js consume; never a parallel copy)
 * and is scope-limited to the task's `### Files in scope`. The caller
 * audit-logs every allow. Fail-closed: any resolution error keeps the
 * RED block.
 */
function _ablationTaskScope(taskBase, safeTicketId, worktreeDir) {
  const taskNum = resolveActiveTaskNum(taskBase, safeTicketId);
  if (!taskNum) return null;
  const shared = require(
    path.join(
      __dirname,
      '..',
      '..',
      'work',
      'lib',
      'step-enrichments',
      'implement-gate',
      'test-command'
    )
  );
  const tasksDir = path.join(taskBase, safeTicketId);
  const execution = shared.resolveTaskTestExecution(tasksDir, taskNum, worktreeDir);
  if (!execution || execution.redMode !== 'ablation') return null;
  const task = shared.findTaskByNum(tasksDir, taskNum);
  return (task && task.filesInScope) || [];
}

function ablationRedEditAllowed(filePath, taskBase, safeTicketId) {
  try {
    if (!filePath || !taskBase) return false;
    const worktreeDir = detectWorktreeDir(safeTicketId);
    if (!worktreeDir) return false;
    const scope = _ablationTaskScope(taskBase, safeTicketId, worktreeDir);
    if (!scope) return false;
    const rel = path.relative(worktreeDir, path.resolve(filePath));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
    const { fileInTaskScope } = require(path.join(__dirname, '..', '..', 'lib', 'task-scope'));
    return fileInTaskScope(rel, scope);
  } catch {
    return false; // fail-closed: keep the RED block
  }
}

/**
 * Check TDD phase restrictions for a file path.
 * Returns 'block', 'allow', 'ablation-allow', 'no-file', or 'no-state'.
 * ('ablation-allow' = a RED-phase source edit permitted by the GH-570
 * ablation allowance — the caller audits it.)
 *
 * Uses per-task tdd-phase.json resolution via allocator (R7, R8).
 * PHASE_HOOKS behavior from tdd-phase-registry.js is UNCHANGED except the
 * machine-verified ablation-RED allowance above.
 */
function checkTddPhase(filePath, ticketId) {
  try {
    if (!ticketId) return 'no-state';

    const taskBase = resolveTaskBase();
    const safeTicketId = resolveSafeTicketId(ticketId);

    const statePath = resolveTddStatePath(taskBase, safeTicketId);
    if (!statePath) return 'no-file';

    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const { PHASE_HOOKS } = require(path.join(__dirname, '..', 'tdd-phase-registry'));
    const hook = PHASE_HOOKS[state.currentPhase];

    if (hook && hook.shouldBlock(filePath)) {
      if (
        state.currentPhase === 'red' &&
        ablationRedEditAllowed(filePath, taskBase, safeTicketId)
      ) {
        return 'ablation-allow';
      }
      process.stderr.write(hook.blockMessage + '\n');
      return 'block';
    }

    return 'allow';
  } catch {
    return 'no-state'; // On error, don't block
  }
}

/**
 * Detect the worktree directory for a ticket.
 *
 * Worktrees follow the convention `<WORKTREES_BASE>/<repo>-<TICKET_ID>` (per
 * inspect.js:44). Detection priority:
 *   1. process.env.WORK_WORKTREE_DIR — explicit override
 *   2. WORKTREES_BASE/<MAIN_WORKTREE_FOLDER>-<safeTicketId> — convention
 *   3. Walk up from process.cwd() looking for a dir whose name ends with
 *      `-<safeTicketId>` and whose parent is WORKTREES_BASE
 *
 * Returns null if no worktree can be confidently identified.
 *
 * @param {string} safeTicketId
 * @returns {string|null}
 */
function detectWorktreeDir(safeTicketId) {
  if (process.env.WORK_WORKTREE_DIR) return path.resolve(process.env.WORK_WORKTREE_DIR);

  // Shared `<WORKTREES_BASE>/<repo>-<ticket>` convention lookup (uses
  // config.REPO_NAME as fallback — same module enforce-tdd-on-stop uses).
  const conventional = conventionWorktreeDir(safeTicketId);
  if (conventional) return conventional;

  // Walk up from cwd looking for `<something>-<safeTicketId>` whose parent
  // is WORKTREES_BASE (or any parent if WORKTREES_BASE unset).
  try {
    const wbase = process.env.WORKTREES_BASE;
    const wbaseResolved = wbase ? path.resolve(wbase) : null;
    let dir = process.cwd();
    const root = path.parse(dir).root;
    while (dir !== root) {
      const base = path.basename(dir);
      if (base.endsWith(`-${safeTicketId}`)) {
        const parent = path.dirname(dir);
        if (!wbaseResolved || path.resolve(parent) === wbaseResolved) {
          return path.resolve(dir);
        }
      }
      dir = path.dirname(dir);
    }
  } catch {
    /* fail-closed */
  }
  return null;
}

/**
 * Build the allowed-paths object for isWriteAllowedPath (R6).
 * Only active when WORK_TASK_NUM is set (task-aware mode).
 * Legacy mode (no WORK_TASK_NUM) skips the path gate entirely.
 *
 * @param {string} taskBase - Resolved TASKS_BASE
 * @param {string} safeTicketId - Sanitized ticket ID
 * @returns {{ prDir: string|null, taskDir: string|null, ticketRoot: string, worktreeDir: string|null }|null}
 */
function buildAllowedPaths(taskBase, safeTicketId) {
  const taskNum = readConfiguredTaskNum(taskBase, safeTicketId);

  // No task num = legacy mode; invalid taskNum = fail-closed
  if (taskNum == null) return null;
  if (!Number.isInteger(taskNum) || taskNum < 1)
    return { prDir: null, taskDir: null, ticketRoot: null, worktreeDir: null };

  const ticketRoot = path.join(taskBase, safeTicketId);
  let taskDir = null;
  try {
    taskDir = path.join(ticketRoot, taskSegment(taskNum));
  } catch {
    taskDir = path.join(ticketRoot, 'task' + taskNum);
  }

  // PR slot for worktree dir
  const prSlot = process.env.WORK_PR_SLOT ? parseInt(process.env.WORK_PR_SLOT, 10) : null;
  const prDir =
    prSlot && Number.isInteger(prSlot) && prSlot > 0 ? path.join(ticketRoot, 'PR' + prSlot) : null;

  // Worktree path — when running inside a `<repo>-<TICKET>` worktree, the
  // entire worktree is the legitimate write zone for this ticket. Most real
  // tasks edit repo source files, not files under tasks/<TICKET>/task{N}/.
  // (Workaround for path-gate-blocks-repo-writes issue from echo-4520-issue-2.)
  const worktreeDir = detectWorktreeDir(safeTicketId);

  return { prDir, taskDir, ticketRoot, worktreeDir };
}

/**
 * Create the audit callback for enforcement records (R13).
 * Wraps appendEnforcementAudit with the ticket context.
 */
function createAuditCallback(ticketId, toolName, filePath, ctx) {
  return (entry) => {
    try {
      const { appendEnforcementAudit } = require(
        path.join(__dirname, '..', '..', 'work', 'lib', 'work-actions')
      );
      appendEnforcementAudit(ticketId, {
        origin: entry.origin || (ctx && ctx.origin) || 'user',
        task: null,
        phase: null,
        action: `${toolName}:${filePath || 'unknown'}`,
        allow: entry.decision === 'allow',
        reason:
          (entry.reasons || []).join('; ') || (entry.decision === 'allow' ? 'allowed' : 'denied'),
        outputPath: filePath || null,
      });
    } catch {
      // Audit is fail-open: never break enforcement for logging
    }
  };
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  const hookData = JSON.parse(input);
  const rt = getRuntime(hookData);
  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};
  const transcriptPath = hookData.transcript_path;

  // Only check blocked tools. The Edit|Write matcher lanes alias-fire for
  // apply_patch on codex (the payload is a raw patch, no file_path).
  if (!BLOCKED_TOOLS.includes(toolName) && toolName !== 'apply_patch') {
    process.exit(0);
  }

  // ── State-based activation (R1): load enforcement context ──────────────
  // If TICKET_ID is explicitly set (even to empty), honor it; otherwise derive
  const ticketId =
    'TICKET_ID' in process.env
      ? process.env.TICKET_ID || null
      : (() => {
          try {
            const { getCurrentTaskId } = require(
              path.join(__dirname, '..', '..', 'lib', 'scripts', 'get-ticket-id.js')
            );
            const id = getCurrentTaskId();
            return id || null;
          } catch {
            try {
              const branch = require('child_process')
                .execSync('git branch --show-current', { encoding: 'utf8' })
                .trim();
              const match = branch.match(/[A-Za-z]+-[0-9]+/i);
              return match ? match[0] : null;
            } catch {
              return null;
            }
          }
        })();

  // No ticket ID => no workflow to enforce
  if (!ticketId) {
    process.exit(0);
  }

  let ctx;
  try {
    const { loadEnforcementContext } = require(
      path.join(__dirname, '..', '..', 'work', 'lib', 'work-enforcement-context')
    );
    ctx = loadEnforcementContext(ticketId);
  } catch {
    // If adapter not available, fail open
    process.exit(0);
  }

  // Check if implement step is active using state (replaces transcript grep)
  if (!isImplementActive(ctx)) {
    process.exit(0);
  }

  // Write targets. Claude tools carry a single file_path; a codex apply_patch
  // lists its targets in the patch headers — EVERY parsed path runs the same
  // gate chain (a multi-file patch with one gated file blocks). Unparseable
  // targets (ok:false) are dropped: this is the advisory workflow gate, the
  // fail-closed lane for unparseable patches is heimdall's (C6).
  const filePaths =
    toolName === 'apply_patch'
      ? parseApplyPatch(toolInput.command)
          .filter((t) => t.ok && t.path)
          .map((t) => t.path)
      : [toolInput.file_path || toolInput.path || ''];

  // Developer identification: payload agent_type first (both runtimes), then
  // the transcript scan (claude Task dispatch grep / codex rollout reader).
  const developerInvoked =
    payloadIsDeveloperAgent(hookData) || hasDeveloperAgentBeenInvoked(transcriptPath);

  for (const filePath of filePaths) {
    // tdd-phase.json is NOT allowed via the generic .json allowlist
    if (filePath && /tdd-phase\.json$/.test(filePath)) {
      process.stderr.write(
        'Direct edit of tdd-phase.json is blocked.\n' +
          'Use tdd-phase-state.js CLI to manage TDD phase state.\n'
      );
      // Audit the block (R13)
      const auditCb = createAuditCallback(ticketId, toolName, filePath, ctx);
      auditCb({ decision: 'deny', reasons: ['TDD_STATE_DIRECT_EDIT'], origin: ctx.origin });
      process.exit(2);
    }

    // ── TDD Phase enforcement (BEFORE allowlist) ─────────────────────────
    const tddPhaseResult = checkTddPhase(filePath, ticketId);
    if (tddPhaseResult === 'block') {
      // Audit the block (R13)
      const auditCb = createAuditCallback(ticketId, toolName, filePath, ctx);
      auditCb({ decision: 'deny', reasons: ['TDD_PHASE_VIOLATION'], origin: ctx.origin });
      process.exit(2);
    }
    // GH-570 (W1×W8): audit the machine-verified ablation-RED source-edit
    // allowance so every fired escape hatch is visible in .work-actions.json.
    // The remaining gates (agent delegation, R6 path gate) still apply below.
    if (tddPhaseResult === 'ablation-allow') {
      const auditCb = createAuditCallback(ticketId, toolName, filePath, ctx);
      auditCb({ decision: 'allow', reasons: ['ABLATION_RED_SOURCE_EDIT'], origin: ctx.origin });
    }
    // Defense-in-depth: if TDD state doesn't exist and this is a production file,
    // block until TDD is initialized.
    if (tddPhaseResult === 'no-file' && !isFileAllowed(filePath) && developerInvoked) {
      // Message sweep (bugs review, W1 follow-up): this hook is now LIVE, so it
      // must not point agents at the OPERATOR-ONLY `exception` subcommand
      // (WORK_OPERATOR_TOKEN-gated — agents following that advice dead-end).
      // Point at the single task entrypoint + the planner Type taxonomy, and
      // the W3 BLOCKED report for tasks that genuinely cannot be test-driven.
      const taskNextScript = path.join(__dirname, '..', 'task-next.js');
      const msg =
        'TDD not initialized. Production file writes are blocked until TDD state exists.\n' +
        'Run the single task entrypoint (it initializes state and dictates the phase):\n' +
        `  node ${taskNextScript} <TICKET_ID> task<N>\n` +
        "TDD exemptions come ONLY from the planner's `### Type` line in tasks.md\n" +
        '(tests-only/docs/config/ci/mechanical-refactor/file-move/checkpoint).\n' +
        'If this task cannot be test-driven and its Type does not exempt it, STOP\n' +
        'and report `BLOCKED (planner-defect): <one-line reason>` back to the\n' +
        'orchestrator.\n';
      process.stderr.write(msg);
      // Audit the block (R13)
      const auditCb = createAuditCallback(ticketId, toolName, filePath, ctx);
      auditCb({ decision: 'deny', reasons: ['TDD_NOT_INITIALIZED'], origin: ctx.origin });
      process.exit(2);
    }

    // Allow config/non-code files
    if (isFileAllowed(filePath)) {
      continue;
    }

    // Check if a developer agent has been invoked
    if (developerInvoked) {
      // -- R6: Task-readiness path gate (when task-aware) --
      // If WORK_TASK_NUM is set, enforce write paths via isWriteAllowedPath.
      // Legacy mode (no WORK_TASK_NUM) skips the path gate.
      const allowedPaths = buildAllowedPaths(resolveTaskBase(), resolveSafeTicketId(ticketId));
      if (allowedPaths && filePath && !isWriteAllowedPath(filePath, allowedPaths)) {
        process.stderr.write(
          'Write to "' +
            filePath +
            '" is outside the allowed path set.\n' +
            'Allowed: PR{N}/, task{N}/, shared whitelist at ticket root.\n' +
            'Verify the file path falls under the claimed worker or task directory.\n'
        );
        const auditCb = createAuditCallback(ticketId, toolName, filePath, ctx);
        auditCb({ decision: 'deny', reasons: ['PATH_NOT_ALLOWED'], origin: ctx.origin });
        process.exit(2);
      }

      continue;
    }

    // Block the operation — audit (R13)
    const auditCb = createAuditCallback(ticketId, toolName, filePath, ctx);
    auditCb({ decision: 'deny', reasons: ['AGENT_DELEGATION_REQUIRED'], origin: ctx.origin });

    process.stderr.write(delegationBlockMessage(toolName, rt.name));
    process.exit(2);
  }

  process.exit(0);
}

/**
 * Delegation block text, per runtime. The claude literal is byte-identical to
 * the historical message; codex has no Task tool (design C1) — the persona
 * runs INLINE, and reading the persona file is the observable dispatch this
 * hook accepts (see codexDeveloperInvocation).
 */
function delegationBlockMessage(toolName, runtime) {
  if (runtime === 'codex') {
    const architectLine =
      process.env.WORK_ARCHITECT_ENABLED === '1'
        ? `  agents/code-architect.md            // Architecture\n`
        : '';
    return (
      `/work-implement requires developer-persona execution\n\n` +
      `Direct ${toolName} blocked. [work:codex-degraded] subagents run INLINE — ` +
      `codex has no Task tool.\n\n` +
      `Read ONE developer persona file from the work plugin's agents/ dir, adopt it,\n` +
      `then re-apply this change inline (the persona read satisfies this gate):\n` +
      `  agents/developer-nodejs-tdd.md      // Backend\n` +
      `  agents/developer-react-senior.md    // React logic\n` +
      `  agents/developer-react-ui-architect.md // UI design\n` +
      `  agents/developer-devops.md          // Infrastructure\n` +
      architectLine +
      `\nOr for simple config changes, edit allowed files:\n` +
      `(.md, .json, .yml, .env, package.json, tsconfig.*, etc.)\n`
    );
  }
  const architectLine =
    process.env.WORK_ARCHITECT_ENABLED === '1'
      ? `  subagent_type: "code-architect",            // Architecture\n`
      : '';
  return (
    `/work-implement requires agent delegation\n\n` +
    `Direct ${toolName} blocked. Use a developer agent first:\n\n` +
    `Task({\n` +
    `  subagent_type: "developer-nodejs-tdd",      // Backend\n` +
    `  subagent_type: "developer-react-senior",    // React logic\n` +
    `  subagent_type: "developer-react-ui-architect", // UI design\n` +
    `  subagent_type: "developer-devops",          // Infrastructure\n` +
    architectLine +
    `  prompt: "Implement: <your task>"\n` +
    `})\n\n` +
    `Or for simple config changes, edit allowed files:\n` +
    `(.md, .json, .yml, .env, package.json, tsconfig.*, etc.)\n`
  );
}

main().catch((err) => {
  logHookError(__filename, err);
  // On error, approve to avoid blocking legitimate operations
  process.exit(0);
});
