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
 * via allocator per-task path with legacy fallback (R7, R8) — see the
 * enforce-task-paths / enforce-tdd-phase sibling modules.
 *
 * When /work-implement is active (state: implement step in_progress),
 * blocks direct Write/Edit operations unless a developer-* agent has
 * been invoked first.
 */

const fs = require('fs');
const path = require('path');
const { runHook } = require(path.join(__dirname, '..', '..', 'lib', 'hookEntrypoint'));
// Vendored dual-runtime adapter: runtime detection (per-runtime block text)
// and apply_patch target parsing.
const { getRuntime } = require(path.join(__dirname, '..', '..', 'lib', 'runtime'));
const { parseApplyPatch } = require(path.join(__dirname, '..', '..', 'lib', 'runtime', 'tools'));

// --- Task 12 import: task-readiness path gate (R6, R12) ---
const { isWriteAllowedPath } = require(path.join(__dirname, '..', '..', 'lib', 'preflight'));
const { resolveTaskBase, resolveSafeTicketId, buildAllowedPaths } = require(
  path.join(__dirname, 'enforce-task-paths')
);
const { resolveTddStatePath, ablationRedEditAllowed } = require(
  path.join(__dirname, 'enforce-tdd-phase')
);
const { payloadIsDeveloperAgent, hasDeveloperAgentBeenInvoked } = require(
  path.join(__dirname, 'enforce-developer-detect')
);
const { tddNotInitializedMessage, delegationBlockMessage } = require(
  path.join(__dirname, 'enforce-messages')
);

// Tools that require agent invocation first
const BLOCKED_TOOLS = ['Write', 'Edit', 'MultiEdit'];

// Files that are allowed without agent (config, non-code files).
// Kept as regex sources so the list reads as data (built once at load).
const ALLOWED_PATTERNS = [
  '\\.md$', // Markdown files
  '\\.json$', // JSON config files
  '\\.ya?ml$', // YAML files
  '\\.env', // Environment files
  '\\.gitignore$', // Git ignore
  '\\.eslintrc', // ESLint config
  '\\.prettierrc', // Prettier config
  'package\\.json$', // Package files
  'tsconfig', // TypeScript config
  '/\\.claude/', // Files in .claude folder (hooks, commands, agents)
  '/__tests__/', // Test directories
  '\\.test\\.[jt]sx?$', // .test.js, .test.ts, .test.tsx
  '\\.spec\\.[jt]sx?$', // .spec.js, .spec.ts, .spec.tsx
  'work-implement-enforce\\.js$', // This file specifically
].map((src) => new RegExp(src));

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
 * Check if the file being edited is allowed without agent
 */
function isFileAllowed(filePath) {
  if (!filePath) return false;
  return ALLOWED_PATTERNS.some((pattern) => pattern.test(filePath));
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
 * Create the audit callback for enforcement records (R13).
 * Wraps appendEnforcementAudit with the ticket context.
 */
function createAuditCallback(ticketId, toolName, filePath, ctx) {
  return (entry) => {
    try {
      const { appendEnforcementAudit } = require(
        path.join(__dirname, '..', '..', 'work', 'lib', 'work-actions')
      );
      const allow = entry.decision === 'allow';
      const joinedReasons = (entry.reasons || []).join('; ');
      appendEnforcementAudit(ticketId, {
        origin: entry.origin || (ctx && ctx.origin) || 'user',
        task: null,
        phase: null,
        action: `${toolName}:${filePath || 'unknown'}`,
        allow,
        reason: joinedReasons || (allow ? 'allowed' : 'denied'),
        outputPath: filePath || null,
      });
    } catch {
      // Audit is fail-open: never break enforcement for logging
    }
  };
}

/** Append one audit row (R13) for the gate's decision on this file. */
function auditDecision(gate, filePath, decision, reasonCode) {
  const auditCb = createAuditCallback(gate.ticketId, gate.toolName, filePath, gate.ctx);
  auditCb({ decision, reasons: [reasonCode], origin: gate.ctx.origin });
}

// ─── Ticket / context resolution ──────────────────────────────────────────

/**
 * Resolve the ticket id (GH-219 R1). If TICKET_ID is explicitly set (even
 * to empty), honor it; otherwise derive via get-ticket-id or the branch.
 */
function resolveTicketId() {
  if ('TICKET_ID' in process.env) return process.env.TICKET_ID || null;
  try {
    const { getCurrentTaskId } = require(
      path.join(__dirname, '..', '..', 'lib', 'scripts', 'get-ticket-id.js')
    );
    return getCurrentTaskId() || null;
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
}

/** Load enforcement context via the adapter; fail open when unavailable. */
function loadContext(ticketId) {
  try {
    const { loadEnforcementContext } = require(
      path.join(__dirname, '..', '..', 'work', 'lib', 'work-enforcement-context')
    );
    return loadEnforcementContext(ticketId);
  } catch {
    // If adapter not available, fail open
    process.exit(0);
  }
}

/**
 * Write targets. Claude tools carry a single file_path; a codex apply_patch
 * lists its targets in the patch headers — EVERY parsed path runs the same
 * gate chain (a multi-file patch with one gated file blocks). Unparseable
 * targets (ok:false) are dropped: this is the advisory workflow gate, the
 * fail-closed lane for unparseable patches is heimdall's (C6).
 */
function collectWriteTargets(toolName, toolInput) {
  if (toolName === 'apply_patch') {
    return parseApplyPatch(toolInput.command)
      .filter((t) => t.ok && t.path)
      .map((t) => t.path);
  }
  return [toolInput.file_path || toolInput.path || ''];
}

// ─── Per-file gate chain ──────────────────────────────────────────────────

/** TDD phase enforcement (BEFORE allowlist) — blocks or audits per phase. */
function enforceTddPhaseGate(filePath, gate) {
  const tddPhaseResult = checkTddPhase(filePath, gate.ticketId);
  if (tddPhaseResult === 'block') {
    auditDecision(gate, filePath, 'deny', 'TDD_PHASE_VIOLATION');
    process.exit(2);
  }
  // GH-570 (W1×W8): audit the machine-verified ablation-RED source-edit
  // allowance so every fired escape hatch is visible in .work-actions.json.
  // The remaining gates (agent delegation, R6 path gate) still apply below.
  if (tddPhaseResult === 'ablation-allow') {
    auditDecision(gate, filePath, 'allow', 'ABLATION_RED_SOURCE_EDIT');
  }
  // Defense-in-depth: if TDD state doesn't exist and this is a production file,
  // block until TDD is initialized.
  if (tddPhaseResult === 'no-file' && !isFileAllowed(filePath) && gate.developerInvoked) {
    process.stderr.write(tddNotInitializedMessage());
    auditDecision(gate, filePath, 'deny', 'TDD_NOT_INITIALIZED');
    process.exit(2);
  }
}

/**
 * R6: Task-readiness path gate (when task-aware). If WORK_TASK_NUM is set,
 * enforce write paths via isWriteAllowedPath. Legacy mode (no WORK_TASK_NUM)
 * skips the path gate.
 */
function enforcePathGate(filePath, gate) {
  const allowedPaths = buildAllowedPaths(resolveTaskBase(), resolveSafeTicketId(gate.ticketId));
  if (!allowedPaths || !filePath || isWriteAllowedPath(filePath, allowedPaths)) return;
  process.stderr.write(
    'Write to "' +
      filePath +
      '" is outside the allowed path set.\n' +
      'Allowed: PR{N}/, task{N}/, shared whitelist at ticket root.\n' +
      'Verify the file path falls under the claimed worker or task directory.\n'
  );
  auditDecision(gate, filePath, 'deny', 'PATH_NOT_ALLOWED');
  process.exit(2);
}

function enforceFileGate(filePath, gate) {
  // tdd-phase.json is NOT allowed via the generic .json allowlist
  if (filePath && /tdd-phase\.json$/.test(filePath)) {
    process.stderr.write(
      'Direct edit of tdd-phase.json is blocked.\n' +
        'Use tdd-phase-state.js CLI to manage TDD phase state.\n'
    );
    auditDecision(gate, filePath, 'deny', 'TDD_STATE_DIRECT_EDIT');
    process.exit(2);
  }

  enforceTddPhaseGate(filePath, gate);

  // Allow config/non-code files
  if (isFileAllowed(filePath)) return;

  // Check if a developer agent has been invoked
  if (gate.developerInvoked) {
    enforcePathGate(filePath, gate);
    return;
  }

  // Block the operation — audit (R13)
  auditDecision(gate, filePath, 'deny', 'AGENT_DELEGATION_REQUIRED');
  process.stderr.write(delegationBlockMessage(gate.toolName, gate.runtimeName));
  process.exit(2);
}

function main(hookData) {
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
  const ticketId = resolveTicketId();

  // No ticket ID => no workflow to enforce
  if (!ticketId) {
    process.exit(0);
  }

  const ctx = loadContext(ticketId);

  // Check if implement step is active using state (replaces transcript grep)
  if (!isImplementActive(ctx)) {
    process.exit(0);
  }

  const filePaths = collectWriteTargets(toolName, toolInput);

  // Developer identification: payload agent_type first (both runtimes), then
  // the transcript scan (claude Task dispatch grep / codex rollout reader).
  const developerInvoked =
    payloadIsDeveloperAgent(hookData) || hasDeveloperAgentBeenInvoked(transcriptPath);

  const gate = { ticketId, toolName, ctx, developerInvoked, runtimeName: rt.name };
  for (const filePath of filePaths) {
    enforceFileGate(filePath, gate);
  }

  process.exit(0);
}

// runHook reads + parses stdin (malformed JSON → {}), runs the handler, and on
// an uncaught throw logs the error and exits 0 (fail-open) to avoid blocking
// legitimate operations. Intentional blocks exit 2 from inside main().
runHook(main, { file: __filename });
