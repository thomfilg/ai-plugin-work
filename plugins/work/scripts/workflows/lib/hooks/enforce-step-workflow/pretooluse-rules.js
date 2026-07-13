'use strict';

/**
 * PreToolUse blocking-rule chain for enforce-step-workflow.js.
 *
 * Extracted (GH-690) to keep the hook entrypoint under the 400-line quality
 * threshold. This module owns ONLY the non-exiting portion of the PreToolUse
 * path — Rules 3 (state-file writes), 3b (unsafe state-script sub-commands),
 * 3c (follow-up PR state files) and 4 (step-gated artifact files) — plus the
 * `handlePreToolUse` orchestration. Rule 5 (agent-gate) and the per-workflow
 * transition loop stay in the entrypoint because they own the process-exit and
 * transition-target invariants the entrypoint's characterization tests pin.
 *
 * Behaviour is byte-for-byte identical to the pre-extraction inline code:
 * `checkPreBlockingRules` returns the FIRST matching block descriptor
 * ({ blocked:true, message } from the wiring) or a `rule3` result carrying
 * `skipRemainingChecks`. The caller decides how to exit, so the fail-open /
 * fail-closed exit contract is unchanged.
 */

/**
 * Run Rules 3 → 3b → 3c/4 in order and return the first blocking descriptor,
 * or the (possibly non-blocking) rule3 result when nothing blocks. Rule 5 is
 * intentionally NOT run here — the caller runs it so its `process.exit(2)`
 * stays in the entrypoint.
 *
 * @returns {{ blocked:boolean, message?:string, skipRemainingChecks?:boolean }}
 */
function checkPreBlockingRules(deps, toolName, toolInput, hookData, ticketId) {
  const { checkStateFileRule, checkUnsafeSubcommands, checkProtectors } = deps;
  const cmd = String(toolInput?.command || '');

  // Rule 3: block state-file writes; hookData → terminal bypasses reject dispatched agents (GH-695)
  const rule3 = checkStateFileRule(toolName, toolInput, ticketId, hookData);
  if (rule3.blocked) return rule3;

  // Rule 3b (GH-89): unsafe state-script sub-commands. Fail-open without a ticket context.
  if (toolName === 'Bash' && ticketId) {
    const rule3b = checkUnsafeSubcommands(cmd.trim(), ticketId, hookData);
    if (rule3b) return { blocked: true, message: rule3b.message };
  }

  // Rule 3c (follow-up PR state files) + Rule 4 (step-gated artifact files)
  const protector = checkProtectors(toolName, toolInput, hookData);
  if (protector.blocked) return { blocked: true, message: protector.message };

  return rule3;
}

/**
 * Build the PreToolUse entrypoint handler. `deps` supplies the wiring functions
 * plus the entrypoint-owned `exitBlocked`, `runRule5` (agent-gate + exit),
 * `runPreWorkflowLoop`, and `getTicketId`.
 *
 * @returns {(hookData: object) => void}
 */
function createHandlePreToolUse(deps) {
  const { exitBlocked, runRule5, runPreWorkflowLoop, getTicketId } = deps;

  return function handlePreToolUse(hookData) {
    const toolName = hookData.tool_name || '';
    const toolInput = hookData.tool_input || {};

    // Find active ticket. May be null when the hook's CWD is not a worktree.
    // Do NOT early-return on null — Rule 5 (token mint) does not need a ticket.
    const ticketId = getTicketId(hookData);

    const rule3 = checkPreBlockingRules(deps, toolName, toolInput, hookData, ticketId);
    if (rule3.blocked) exitBlocked(rule3.message);

    // Rule 5: agent-gate. Exits from the entrypoint (keeps its process.exit(2)).
    runRule5(toolName, toolInput, hookData, ticketId);

    if (rule3.skipRemainingChecks) return; // Edit/Write/MultiEdit — skip per-workflow loop

    // The per-workflow state/transition loop needs a ticketId to load any state.
    if (!ticketId) return;
    runPreWorkflowLoop(ticketId, toolName, toolInput);
  };
}

module.exports = { checkPreBlockingRules, createHandlePreToolUse };
