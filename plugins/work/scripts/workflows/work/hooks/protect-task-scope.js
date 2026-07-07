#!/usr/bin/env node

/**
 * PreToolUse hook — Gate D: block file writes outside the active task's
 * declared scope.
 *
 * Looks up (via task-scope-context):
 *   - Active ticket via .git/HEAD ([A-Z]+-\d+ match)
 *   - tasksDir = TASKS_BASE/safeTicketId(ticket)
 *   - .work-state.json → tasksMeta.currentTaskIndex
 *   - tasks.md → active task → filesInScope / filesOutOfScope
 *
 * For every Write / Edit / MultiEdit / NotebookEdit / Bash tool call, runs
 * the scope-protection policy. Blocks (exit 2) when:
 *   - The target path matches `filesOutOfScope` (sibling-owned), OR
 *   - The target path is not matched by any `filesInScope` glob.
 *
 * Escape hatches (GH-392 Task 8 + follow-up):
 *   1. Env var PAIR — `PROTECT_TASK_SCOPE_BYPASS_REASON` AND
 *      `PROTECT_TASK_SCOPE_BYPASS_TARGET` must BOTH be set, AND
 *      `WORK_OPERATOR_TOKEN=1` must also be present in the environment
 *      (GH-528 round-2 follow-up ITEM 1). The bypass only fires when the
 *      relativized target matches `BYPASS_TARGET` exactly OR via the same
 *      `findMatch` glob logic used elsewhere (so glob patterns like
 *      `src/shared/**` are honoured). One-shot by design: REASON alone opens
 *      a hole for any path; pairing it with TARGET pins the bypass to a
 *      single planned edit. When fired, appends a `scope-bypass` audit row
 *      via `appendEnforcementAudit` (spec §P0#6) carrying both the configured
 *      TARGET and the actual write path.
 *
 *      WORK_OPERATOR_TOKEN gate (GH-528 round-2 ITEM 1): bypass env vars
 *      inherit into every child process the agent spawns, so an agent that
 *      can set REASON+TARGET in its own shell would otherwise be able to
 *      flip the bypass on without operator intent. The token is an
 *      operator-only env var (same pattern as the `exception` subcommand
 *      in tdd-phase-state.js) that the agent's harness never carries. When
 *      the token is missing AND REASON+TARGET match the write target, the
 *      hook treats the env pair as unset (block stays) and appends a
 *      `scope-bypass-rejected` audit row carrying the configured target
 *      and reason — so the rejected attempt is visible without trusting
 *      caller-supplied state.
 *   2. `### Cross-Task Dependencies` — paths in the active task's
 *      `crossTaskDeps` list bypass the would-be block and append a
 *      `cross-task-dep-allow` audit row (spec §P0#7b).
 *
 * Security: bypass paths fail closed on missing ticket identity (no ticket →
 * no bypass; the early `if (!ticketId) process.exit(0)` rejects un-scoped
 * invocations before either escape hatch is evaluated).
 *
 * Fail-open in all error paths (missing state, parse error, missing config) —
 * agents on legitimate non-implement steps must not be blocked by this hook.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const { logHookError } = require(path.join(__dirname, '..', '..', 'lib', 'hook-error-log'));
const { decideEdit, relativizePath } = require(
  path.join(__dirname, '..', '..', 'lib', 'hooks', 'policies', 'scope-protection')
);
const { evaluateScopeBypass, crossTaskDepAllows } = require(
  path.join(__dirname, 'task-scope-bypass')
);
const { getTicketId, getTasksDir, getActiveTask } = require(
  path.join(__dirname, 'task-scope-context')
);
const {
  FILE_WRITE_TOOLS,
  extractApplyPatchWriteTargets,
  extractBashWriteTargets,
  extractTargetPath,
} = require(path.join(__dirname, 'task-scope-write-targets'));
const { TYPE_ENFORCED_KINDS, typeAllowlistDecision, typeLineGuard, extractTypeLines } = require(
  path.join(__dirname, 'task-scope-type-guard')
);

/**
 * Honor the one-shot env-var escape hatch for the Type-line guard. Returns
 * true when the bypass fired (audit appended, caller should exit 0).
 */
function tryTypeLineBypass(toolName, toolInput, cwd, ticketId, active) {
  const rel = relativizePath(extractTargetPath(toolName, toolInput) || '', cwd);
  const verdict = evaluateScopeBypass({
    ticketId,
    active,
    relTarget: rel,
    guard: 'type-line',
    allowGuard: 'type-line',
  });
  return verdict === 'allowed';
}

// ─── Scope evaluation ───────────────────────────────────────────────────────

/** First blocking scope decision across a list of write targets, or null. */
function decideForTargets(targets, active, workDir) {
  for (const tgt of targets) {
    const d = decideEdit({
      filePath: tgt,
      workDir,
      filesInScope: active.filesInScope,
      filesOutOfScope: active.filesOutOfScope,
      activeTask: active.label,
    });
    if (d.blocked) return d;
  }
  return null;
}

function evaluateTool(toolName, toolInput, active, workDir) {
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const filePath = toolInput && toolInput.file_path;
    if (!filePath) return null;
    return decideEdit({
      filePath,
      workDir,
      filesInScope: active.filesInScope,
      filesOutOfScope: active.filesOutOfScope,
      activeTask: active.label,
    });
  }
  if (toolName === 'apply_patch') {
    // Codex write vector: the Edit|Write matcher lanes alias-fire for
    // apply_patch; every parsed patch target goes through the same scope
    // decision as a direct file write.
    return decideForTargets(extractApplyPatchWriteTargets(toolInput), active, workDir);
  }
  if (toolName === 'Bash') {
    const cmd = toolInput && toolInput.command;
    if (!cmd) return null;
    return decideForTargets(extractBashWriteTargets(String(cmd)), active, workDir);
  }
  return null;
}

// ─── Main hook ──────────────────────────────────────────────────────────────

/** Read + parse the hook payload; fail-open (exit 0) on malformed JSON. */
async function readHookPayload() {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try {
    return JSON.parse(raw);
  } catch {
    process.exit(0); // fail-open
  }
}

/** Resolve ticket + active task, exiting 0 (fail-open) when Gate D is idle. */
function resolveActiveScope(cwd) {
  const ticketId = getTicketId(cwd);
  if (!ticketId) process.exit(0); // no /work context

  const tasksDir = getTasksDir(ticketId);
  if (!tasksDir || !fs.existsSync(tasksDir)) process.exit(0);

  const active = getActiveTask(tasksDir);
  if (!active || active.skip) process.exit(0);
  if (active.filesInScope.length === 0 && active.filesOutOfScope.length === 0) process.exit(0);

  return { ticketId, tasksDir, active };
}

/**
 * GH-528 item 5: Type-line edit guard runs before scope evaluation.
 * tasks.md is generally out of scope already, but this specifically
 * blocks the bypass of flipping `### Type` mid-implement.
 */
function enforceTypeLineGuard(toolName, toolInput, cwd, tasksDir, ticketId, active) {
  const typeLineDecision = typeLineGuard(toolName, toolInput, cwd, tasksDir);
  if (!typeLineDecision.blocked) return;
  if (tryTypeLineBypass(toolName, toolInput, cwd, ticketId, active)) process.exit(0);
  process.stderr.write(typeLineDecision.reason + '\n');
  process.exit(2);
}

/**
 * Scope decision + escape hatches. Checked after the `decision.blocked`
 * gate so we only audit genuinely bypassed blocks. We fail closed when no
 * ticket was detected (early exit in resolveActiveScope), so identity is
 * established here.
 */
function enforceScopeDecision(toolName, toolInput, cwd, ticketId, active) {
  const decision = evaluateTool(toolName, toolInput, active, cwd);
  if (!decision || !decision.blocked) return;

  const target = extractTargetPath(toolName, toolInput) || '';
  const relTarget = relativizePath(target, cwd);

  // Env-var escape hatch: 'rejected' and 'no-bypass' both fall through to
  // the cross-task check below (a rejected bypass keeps the block, but a
  // cross-task dependency may still legitimately allow the write).
  const verdict = evaluateScopeBypass({ ticketId, active, relTarget, guard: 'files-in-scope' });
  if (verdict === 'allowed') process.exit(0);

  if (crossTaskDepAllows(ticketId, active, relTarget)) process.exit(0);

  process.stderr.write(decision.reason + '\n');
  process.exit(2);
}

/**
 * GH-528 item 5: per-Type closed-allowlist check. Runs after the standard
 * filesInScope decision has allowed the write. For tdd-code / checkpoint /
 * mechanical-refactor / file-move, returns {blocked:false} unconditionally
 * (their existing behavior). Honors the one-shot env-var bypass pair so
 * operators can still pin a single override target across this layer.
 */
function checkPerTypeAllowlist(active, toolName, toolInput, cwd, ticketId) {
  if (!active.type || !TYPE_ENFORCED_KINDS.has(active.type)) return { blocked: false };
  const target = extractTargetPath(toolName, toolInput) || '';
  if (!target) return { blocked: false };
  const relTarget = relativizePath(target, cwd);
  if (!relTarget) return { blocked: false };
  const verdict = evaluateScopeBypass({
    ticketId,
    active,
    relTarget,
    guard: 'type-allowlist',
    allowGuard: 'type-allowlist',
  });
  if (verdict === 'allowed') return { blocked: false };
  // 'rejected' falls through to the allowlist decision (block stays).
  return typeAllowlistDecision(active.type, relTarget);
}

async function main() {
  const hookData = await readHookPayload();

  const cwd = process.cwd();
  const { ticketId, tasksDir, active } = resolveActiveScope(cwd);

  const toolName = hookData.tool_name || '';
  const toolInput = hookData.tool_input || {};

  enforceTypeLineGuard(toolName, toolInput, cwd, tasksDir, ticketId, active);
  enforceScopeDecision(toolName, toolInput, cwd, ticketId, active);

  const typeBlock = checkPerTypeAllowlist(active, toolName, toolInput, cwd, ticketId);
  if (typeBlock.blocked) {
    process.stderr.write(typeBlock.reason + '\n');
    process.exit(2);
  }
  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    try {
      logHookError(__filename, err);
    } catch {
      /* swallow */
    }
    process.exit(0);
  });
}

module.exports = {
  evaluateTool,
  extractBashWriteTargets,
  extractApplyPatchWriteTargets,
  getTicketId,
  getActiveTask,
  typeAllowlistDecision,
  typeLineGuard,
  extractTypeLines,
  TYPE_ENFORCED_KINDS,
};
