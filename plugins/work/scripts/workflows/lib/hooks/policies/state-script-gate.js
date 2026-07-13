/**
 * policies/state-script-gate.js — strict Bash-command gating for state scripts,
 * extracted from enforce-step-workflow.js:
 *   - shellTokenize(): quote-aware tokenizer (./shell-tokenize, re-exported)
 *   - isTerminalCompleteBypass(): `work-state.js complete` at the terminal step (GH-276)
 *   - isTerminalCancelBypass(): `work-state.js cancel` in a planning phase (GH-339)
 *   - isTerminalSessionGuardBypass(): session-guard.js finish/reveal/complete at
 *     the terminal step, or a cancelled state (GH-338 + GH-339)
 *   - checkUnsafeSubcommands(): Rule 3b — block unsafe sub-commands (GH-89)
 */

const path = require('path');
const { getNodeInvocations } = require('./command-matching');
const {
  isTrustedScriptPath,
  expandPluginRoot,
  extractSubCommand,
  isSafeSubCommand,
} = require('./agent-authorization');
// Quote-aware tokenizer — extracted verbatim to ./shell-tokenize (file-size
// burndown); re-exported below so consumers keep this import path.
const { shellTokenize } = require('./shell-tokenize');
// GH-339: single source of truth for the planning-phase cancel boundary (the
// gate must not re-derive the ceiling that work-state's cancelWork enforces).
const { isCancellablePhase } = require('../../../work/work-state/steps');

// Shared strict token walk for `node <path>/work-state.js <subCmd> <ticket>`.
// Env-assignment prefixes (FOO=bar node ...) are DISALLOWED entirely — they'd let
// an attacker inject NODE_OPTIONS/NODE_PATH/LD_PRELOAD/DYLD_* (honored by Node
// before the script runs). Orchestrator's strict direct call only: no wrappers,
// env prefix, or node flags. Returns `{ scriptPath, targetTicket, next }` (caller
// validates trailing tokens from `next`), or null on a bad prefix shape.
function extractWorkStatePrefix(tokens, subCmd, trace) {
  let i = 0;
  if (!/^(?:node|nodejs)$/.test(tokens[i])) {
    trace('reject: no node token', { i, token: tokens[i] });
    return null;
  }
  i++;
  if (i < tokens.length && tokens[i].startsWith('-')) {
    trace('reject: node flag before script', { token: tokens[i] });
    return null;
  }
  if (i >= tokens.length) {
    trace('reject: no script token');
    return null;
  }
  const scriptPath = tokens[i].replace(/^['"]|['"]$/g, '');
  i++;
  if (!/[\\/]work-state\.js$/.test(scriptPath)) {
    trace('reject: not work-state.js', { scriptPath });
    return null;
  }
  if (i >= tokens.length || tokens[i] !== subCmd) {
    trace(`reject: sub-command not ${subCmd}`, { token: tokens[i] });
    return null;
  }
  i++;
  if (i >= tokens.length) {
    trace('reject: no ticket token');
    return null;
  }
  return { scriptPath, targetTicket: tokens[i], next: i + 1 };
}

function extractCompleteArgs(tokens, trace) {
  const p = extractWorkStatePrefix(tokens, 'complete', trace);
  if (p === null) return null;
  if (p.next !== tokens.length) {
    trace('reject: trailing tokens', { remaining: tokens.slice(p.next) });
    return null;
  }
  return { scriptPath: p.scriptPath, targetTicket: p.targetTicket };
}

// GH-339: `node <path>/work-state.js cancel <ticket> --reason <text>`. Reuses
// extractWorkStatePrefix' scaffold, allows exactly one trailing `--reason
// <value>` pair (the reason value is opaque / recorded verbatim).
function extractCancelArgs(tokens, trace) {
  const p = extractWorkStatePrefix(tokens, 'cancel', trace);
  if (p === null) return null;
  let i = p.next;
  if (i >= tokens.length || tokens[i] !== '--reason') {
    trace('reject: missing --reason', { token: tokens[i] });
    return null;
  }
  i += 2; // consume `--reason` + its value
  if (i > tokens.length) {
    trace('reject: --reason without value');
    return null;
  }
  if (i !== tokens.length) {
    trace('reject: trailing tokens', { remaining: tokens.slice(i) });
    return null;
  }
  return { scriptPath: p.scriptPath, targetTicket: p.targetTicket };
}

// Skip env-assignment prefixes and the node token; reject node flags.
// Returns the index of the script-path token, or null when the shape is wrong.
function skipEnvAndNodeTokens(tokens) {
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length || !/^(?:node|nodejs)$/.test(tokens[i])) return null;
  i++;

  if (i < tokens.length && tokens[i].startsWith('-')) return null;
  return i;
}

// Strict token walk for `node <path>/session-guard.js <finish|reveal|complete> <ticket>`.
// Env-assignment prefixes are skipped (legacy shape), node flags rejected.
function extractSessionGuardArgs(tokens) {
  let i = skipEnvAndNodeTokens(tokens);
  if (i === null) return null;

  if (i >= tokens.length) return null;
  const scriptPath = tokens[i].replace(/^['"]|['"]$/g, '');
  i++;
  if (!/[\\/]session-guard\.js$/.test(scriptPath)) return null;

  if (i >= tokens.length) return null;
  const subCmd = tokens[i];
  if (subCmd !== 'finish' && subCmd !== 'reveal' && subCmd !== 'complete') return null;
  i++;

  if (i >= tokens.length) return null;
  const targetTicket = tokens[i];
  i++;

  if (i !== tokens.length) return null;
  return { scriptPath, targetTicket };
}

function makeTrace(enabled, label = 'isTerminalCompleteBypass') {
  return (reason, extra) => {
    if (enabled) {
      try {
        process.stderr.write(
          `[${label}] ${reason}` + (extra ? ` | ${JSON.stringify(extra)}` : '') + '\n'
        );
      } catch {
        /* never throw from debug */
      }
    }
  };
}

// GH-695: guidance appended to block messages when a dispatched agent attempts
// a terminal bypass. The mechanical block must be legible — the agent's correct
// move is reporting the wedge, and a misclassified orchestrator gets the most
// common cause (a leaked env var) named.
const DISPATCHED_AGENT_GUIDANCE =
  'Dispatched-agent context detected: the terminal bypass is orchestrator-only (GH-695).\n' +
  'Report `BLOCKED: <detail>` to the orchestrator instead of finishing the workflow yourself.\n' +
  'If you ARE the orchestrator, check for a leaked CLAUDE_CURRENT_AGENT env var in this session.\n';

// GH-695: whether this (scriptBase, subCmd) pair is one of the terminal
// bypasses — the only allowlist entries the dispatched-agent rejection guards.
function isTerminalBypassEligible(scriptBase, subCmd) {
  // GH-339: `cancel` joins `complete` as a terminal-bypass sub-command on
  // work-state.js so a dispatched agent attempting it gets the guidance below.
  if (scriptBase === 'work-state.js') return subCmd === 'complete' || subCmd === 'cancel';
  if (scriptBase === 'session-guard.js') {
    return subCmd === 'finish' || subCmd === 'reveal' || subCmd === 'complete';
  }
  return false;
}

// GH-695: true when the hook context belongs to ANY dispatched agent.
// Errors → false (fail-open at the hook; the completeWork script-side
// precondition is the backstop). Missing dep keeps legacy behavior.
function isDispatchedContext(deps, hookData) {
  try {
    if (typeof deps.isDispatchedAgentContext !== 'function') return false;
    return deps.isDispatchedAgentContext(hookData?.transcript_path, hookData) === true;
  } catch {
    return false;
  }
}

// Verify the /work workflow is at the terminal `complete` step — reuses the
// shared getCurrentStep helper for consistent multi-in_progress handling.
function isAtTerminalStep(deps, ticketId, trace, debugBypass) {
  const state = deps.loadStateFile(ticketId, '.work-state.json');
  const currentStep = deps.getCurrentStep(state, deps.workSteps);
  if (currentStep === 'complete') return true;
  if (debugBypass) {
    trace('reject: not at terminal step', {
      currentStep,
      ticketId,
      TASKS_BASE: deps.tasksBase,
      safeTicketed: deps.safeTicketPath(ticketId),
      stateLoaded: !!state,
      stateHasStepStatus: !!state?.stepStatus,
      stepStatusKeys: state?.stepStatus ? Object.keys(state.stepStatus) : null,
      completeVal: state?.stepStatus?.complete,
      WORK_STEPS_len: deps.workSteps.length,
    });
  } else {
    trace('reject: not at terminal step', { currentStep });
  }
  return false;
}

// Quote-aware tokenizer (work-state bypasses): treats quoted runs as one token
// so paths with spaces survive; unbalanced quotes → null → reject.
function tokenizeQuoteAware(cmd) {
  return shellTokenize(String(cmd).trim());
}

// GH-338 tokenizer (session-guard bypass): strip balanced quote pairs, then
// split — quoted and unquoted forms tokenize identically on every Node / OS.
function tokenizeStripQuotes(cmd) {
  return String(cmd)
    .trim()
    .replace(/"([^"]*)"/g, '$1')
    .replace(/'([^']*)'/g, '$1')
    .split(/\s+/);
}

// Shared strict-invocation checks for the terminal bypasses (GH-276 complete,
// GH-339 cancel, GH-338 session-guard): dispatched-agent rejection FIRST
// (GH-695), no shell metachars, tokenize, extractor-parsed strict shape, trusted
// script path, ticket match. Returns `true` when all pass; the caller then
// applies its own step/status predicate.
function passesStrictBypass(deps, cmd, ticketId, hookData, extractArgs, trace, tokenize) {
  // GH-695: reject FIRST when the caller is ANY dispatched agent.
  if (isDispatchedContext(deps, hookData)) {
    trace('reject: dispatched-agent context');
    return false;
  }
  if (/[;&|$`<>(){}\n]/.test(cmd)) {
    trace('reject: shell metachars');
    return false;
  }
  const tokens = tokenize(cmd);
  if (tokens === null) {
    trace('reject: unbalanced quotes');
    return false;
  }
  trace('tokens', { count: tokens.length, tokens });

  const args = extractArgs(tokens, trace);
  if (args === null) return false;

  const resolvedPath = expandPluginRoot(args.scriptPath);
  deps.debugLogCandidatePath(resolvedPath);
  if (!isTrustedScriptPath(resolvedPath, deps.trustedDirs)) {
    trace('reject: untrusted script path', { resolvedPath });
    return false;
  }
  if (args.targetTicket !== ticketId) {
    trace('reject: ticket mismatch', { targetTicket: args.targetTicket, ticketId });
    return false;
  }
  return true;
}

// Step-conditional bypass for `work-state.js complete` (GH-276): passesStrictBypass
// (dispatched-rejected, strict shape, trusted path, ticket match) AND the workflow
// is at the terminal `complete` step.
function isTerminalCompleteBypass(deps, cmd, ticketId, hookData) {
  const DEBUG_BYPASS = process.env.ENFORCE_HOOK_DEBUG === '1';
  const trace = makeTrace(DEBUG_BYPASS);
  const args = [deps, cmd, ticketId, hookData, extractCompleteArgs, trace, tokenizeQuoteAware];
  if (!passesStrictBypass(...args)) return false;
  if (!isAtTerminalStep(deps, ticketId, trace, DEBUG_BYPASS)) return false;
  trace('allow');
  return true;
}

// Step-conditional bypass for `work-state.js cancel <ticket> --reason <text>`
// (GH-339): passesStrictBypass AND the workflow is at a cancellable (planning)
// step. Gates on isCancellablePhase instead of the terminal `complete` step.
function isTerminalCancelBypass(deps, cmd, ticketId, hookData) {
  const trace = makeTrace(process.env.ENFORCE_HOOK_DEBUG === '1', 'isTerminalCancelBypass');
  const args = [deps, cmd, ticketId, hookData, extractCancelArgs, trace, tokenizeQuoteAware];
  if (!passesStrictBypass(...args)) return false;
  const state = deps.loadStateFile(ticketId, '.work-state.json');
  const currentStep = deps.getCurrentStep(state, deps.workSteps);
  if (!isCancellablePhase(currentStep)) {
    trace('reject: not a cancellable (planning) step', { currentStep });
    return false;
  }
  trace('allow');
  return true;
}

// Step-conditional bypass for session-guard.js finish/reveal/complete (GH-338):
// passesStrictBypass (strip-quote tokenizer, env-prefix-tolerant extractor) AND
// a released terminal state (complete step, or GH-339 cancelled status).
function isTerminalSessionGuardBypass(deps, cmd, ticketId, hookData) {
  const trace = makeTrace(process.env.ENFORCE_HOOK_DEBUG === '1', 'isTerminalSessionGuardBypass');
  const args = [deps, cmd, ticketId, hookData, extractSessionGuardArgs, trace, tokenizeStripQuotes];
  if (!passesStrictBypass(...args)) return false;
  const state = deps.loadStateFile(ticketId, '.work-state.json');
  // GH-338: the terminal `complete` step releases the guard. GH-339 additively
  // allows release when the workflow was cancelled (status === 'cancelled'),
  // WITHOUT weakening the dispatched-agent rejection above or the complete-step
  // allowance — the cancel path is the sanctioned atomic teardown too.
  return isReleasedTerminalState(deps.getCurrentStep(state, deps.workSteps), state);
}

// GH-339: guard release is sanctioned at the terminal `complete` step (GH-338)
// OR when the state was cancelled — a named predicate keeps the OR additive.
function isReleasedTerminalState(currentStep, state) {
  return currentStep === 'complete' || state?.status === 'cancelled';
}

// Step-conditional bypasses shared by Rule 3 and Rule 3b.
function isTerminalBypassAllowed(deps, scriptBase, subCmd, cmd, ticketId, hookData) {
  // work-state.js complete at terminal step (GH-276)
  if (scriptBase === 'work-state.js' && subCmd === 'complete') {
    return isTerminalCompleteBypass(deps, cmd, ticketId, hookData);
  }
  // work-state.js cancel in a planning phase (GH-339) — Rule 3b, dispatched first
  if (scriptBase === 'work-state.js' && subCmd === 'cancel') {
    return isTerminalCancelBypass(deps, cmd, ticketId, hookData);
  }
  // session-guard.js finish/reveal/complete at terminal step (GH-338)
  if (
    scriptBase === 'session-guard.js' &&
    (subCmd === 'finish' || subCmd === 'reveal' || subCmd === 'complete')
  ) {
    return isTerminalSessionGuardBypass(deps, cmd, ticketId, hookData);
  }
  return false;
}

/**
 * Rule 3b: Block unsafe sub-commands on state scripts invoked via node (GH-89).
 * Defense-in-depth: the stateFileProtector's isExempt/Vector 3 may miss the script when
 * multi-arg flags (--require, -r, etc.) cause INTERPRETER_PATTERN to capture the flag
 * argument instead of the actual script. This rule uses the improved nodePattern directly.
 *
 * @returns {{ blocked: true, message: string } | null}
 */
function checkUnsafeSubcommands(deps, cmd, ticketId, hookData) {
  const stateMatches = getNodeInvocations(cmd);
  for (const m of stateMatches) {
    const scriptPath = m[1] || m[2] || m[3];
    const scriptBase = path.basename(scriptPath);
    const safeSet = deps.safeSubcommands[scriptBase];
    if (!safeSet) continue;
    const resolvedPath = expandPluginRoot(scriptPath);
    // Verify trusted directory - skip untrusted (Vector 3 handles those)
    deps.debugLogCandidatePath(resolvedPath);
    if (!isTrustedScriptPath(resolvedPath, deps.trustedDirs)) continue;

    const subCmd = extractSubCommand(cmd, m, scriptBase);
    if (isSafeSubCommand(scriptBase, subCmd, deps.safeSubcommands)) continue;
    if (isTerminalBypassAllowed(deps, scriptBase, subCmd, cmd, ticketId, hookData)) continue;
    let message =
      `BLOCKED: Direct Bash call to ${scriptBase} with sub-command '${subCmd}' is not allowed.\n` +
      `State files must only be modified through the orchestrator/workflow-engine scripts.\n`;
    // GH-695: a dispatched agent attempting a terminal bypass gets told the
    // correct move (report the wedge) instead of a mysterious denial.
    if (isTerminalBypassEligible(scriptBase, subCmd) && isDispatchedContext(deps, hookData)) {
      message += DISPATCHED_AGENT_GUIDANCE;
    }
    return { blocked: true, message };
  }
  return null;
}

/**
 * Create the state-script gate bound to the hook's runtime context.
 *
 * @param {object} deps
 * @param {string[]} deps.trustedDirs — realpath-normalised TRUSTED_SCRIPT_DIRS
 * @param {object} deps.safeSubcommands — SAFE_SUBCOMMANDS map
 * @param {Function} deps.loadStateFile — (ticketId, stateFile) => state|null
 * @param {Function} deps.getCurrentStep — (state, steps) => step|null
 * @param {string[]} deps.workSteps — ALL_STEPS of the /work workflow
 * @param {string} deps.tasksBase — TASKS_BASE (debug traces only)
 * @param {Function} deps.safeTicketPath — ticket sanitizer (debug traces only)
 * @param {Function} deps.debugLogCandidatePath — GH-452 diagnostic
 * @param {Function} [deps.isDispatchedAgentContext] — GH-695 dispatched-agent
 *   detector (transcriptPath, hookData) => boolean; when absent the terminal
 *   bypasses keep their pre-GH-695 (orchestrator-assumed) behavior
 */
function createStateScriptGate(deps) {
  return {
    isTerminalCompleteBypass: (cmd, ticketId, hookData) =>
      isTerminalCompleteBypass(deps, cmd, ticketId, hookData),
    isTerminalSessionGuardBypass: (cmd, ticketId, hookData) =>
      isTerminalSessionGuardBypass(deps, cmd, ticketId, hookData),
    checkUnsafeSubcommands: (cmd, ticketId, hookData) =>
      checkUnsafeSubcommands(deps, cmd, ticketId, hookData),
    isDispatchedContext: (hookData) => isDispatchedContext(deps, hookData),
  };
}

module.exports = {
  shellTokenize, // quote-aware tokenizer (exported for reuse/tests)
  createStateScriptGate, // terminal bypasses + Rule 3b sub-command gate
  DISPATCHED_AGENT_GUIDANCE, // GH-695 block-message guidance (reused by Rule 3)
  isTerminalBypassEligible, // GH-695 terminal-bypass (script, subCmd) predicate
};
