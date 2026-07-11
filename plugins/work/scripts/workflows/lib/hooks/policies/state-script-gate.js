/**
 * policies/state-script-gate.js
 *
 * Strict Bash-command gating for state scripts, extracted from
 * enforce-step-workflow.js:
 *
 *   - shellTokenize(): quote-aware tokenizer (lives in ./shell-tokenize,
 *     re-exported here)
 *   - isTerminalCompleteBypass(): `work-state.js complete` allowed only at
 *     the terminal `complete` step (GH-276)
 *   - isTerminalSessionGuardBypass(): session-guard.js finish/reveal/complete
 *     allowed only at the terminal step (GH-338)
 *   - checkUnsafeSubcommands(): Rule 3b — block unsafe sub-commands on state
 *     scripts invoked via node (GH-89)
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

// Strict token walk for `node <path>/work-state.js complete <ticket>`.
// Env-assignment prefixes (FOO=bar node ...) are DISALLOWED entirely — they
// would let an attacker inject `NODE_OPTIONS=--require=/evil/module` (or
// NODE_PATH, LD_PRELOAD, DYLD_*, NODE_TLS_REJECT_UNAUTHORIZED, etc.) which
// Node.js honors before executing the legitimate script. The bypass is for
// the orchestrator's strict, direct call only — no wrappers, no env prefix.
function extractCompleteArgs(tokens, trace) {
  let i = 0;
  if (!/^(?:node|nodejs)$/.test(tokens[i])) {
    trace('reject: no node token', { i, token: tokens[i] });
    return null;
  }
  i++;

  // Strict bypass: no node flags allowed before the script path.
  if (i < tokens.length && tokens[i].startsWith('-')) {
    trace('reject: node flag before script', { token: tokens[i] });
    return null;
  }

  // Script path token. Quote-stripping is unnecessary after normalization but
  // kept defensively for nested-quote pathological inputs.
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

  // Sub-command must be exactly `complete`.
  if (i >= tokens.length || tokens[i] !== 'complete') {
    trace('reject: sub-command not complete', { token: tokens[i] });
    return null;
  }
  i++;

  // Ticket arg.
  if (i >= tokens.length) {
    trace('reject: no ticket token');
    return null;
  }
  const targetTicket = tokens[i];
  i++;

  // No trailing tokens allowed — strict format only.
  if (i !== tokens.length) {
    trace('reject: trailing tokens', { remaining: tokens.slice(i) });
    return null;
  }
  return { scriptPath, targetTicket };
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
  if (scriptBase === 'work-state.js') return subCmd === 'complete';
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

/**
 * Step-conditional bypass for `work-state.js complete` at the terminal step (GH-276).
 * Returns true ONLY when ALL conditions are met:
 *   1. The context is NOT a dispatched agent (GH-695 — orchestrator-only)
 *   2. Command is a strict `node <path>/work-state.js complete <ticketId>` invocation
 *   3. No shell operators, substitutions, or extra arguments
 *   4. Target ticket matches the active ticket
 *   5. The workflow is at the terminal `complete` step
 */
function isTerminalCompleteBypass(deps, cmd, ticketId, hookData) {
  const DEBUG_BYPASS = process.env.ENFORCE_HOOK_DEBUG === '1';
  const trace = makeTrace(DEBUG_BYPASS);

  // GH-695: reject FIRST when the caller is ANY dispatched agent — gates that
  // only bind the orchestrator are not gates.
  if (isDispatchedContext(deps, hookData)) {
    trace('reject: dispatched-agent context');
    return false;
  }

  // Reject shell operators and substitutions — cheapest syntactic fail-fast.
  if (/[;&|$`<>(){}\n]/.test(cmd)) {
    trace('reject: shell metachars');
    return false;
  }

  // Quote-aware tokenizer: split on whitespace BUT treat quoted runs as one
  // token. This is critical for paths containing spaces (e.g. macOS
  // `/Users/John Smith/...`). Unbalanced quotes return null → reject.
  const tokens = shellTokenize(String(cmd).trim());
  if (tokens === null) {
    trace('reject: unbalanced quotes');
    return false;
  }
  trace('tokens', { count: tokens.length, tokens });

  // Expect exactly: node <path/work-state.js> complete <ticket>
  if (tokens.length !== 4) {
    trace('reject: token count not 4');
    return false;
  }

  const args = extractCompleteArgs(tokens, trace);
  if (args === null) return false;

  // Verify script path is trusted.
  const resolvedPath = expandPluginRoot(args.scriptPath);
  deps.debugLogCandidatePath(resolvedPath);
  if (!isTrustedScriptPath(resolvedPath, deps.trustedDirs)) {
    trace('reject: untrusted script path', { resolvedPath });
    return false;
  }

  // Verify ticket arg matches active ticket.
  if (args.targetTicket !== ticketId) {
    trace('reject: ticket mismatch', { targetTicket: args.targetTicket, ticketId });
    return false;
  }

  if (!isAtTerminalStep(deps, ticketId, trace, DEBUG_BYPASS)) return false;
  trace('allow');
  return true;
}

/**
 * Step-conditional bypass for session-guard.js finish/reveal/complete at
 * the terminal step (GH-338). Mirrors isTerminalCompleteBypass() but for
 * session-guard.js subcommands.
 */
function isTerminalSessionGuardBypass(deps, cmd, ticketId, hookData) {
  // GH-695: reject FIRST when the caller is ANY dispatched agent.
  if (isDispatchedContext(deps, hookData)) {
    makeTrace(
      process.env.ENFORCE_HOOK_DEBUG === '1',
      'isTerminalSessionGuardBypass'
    )('reject: dispatched-agent context');
    return false;
  }

  // Reject shell operators and substitutions — cheapest syntactic fail-fast.
  if (/[;&|$`<>(){}\n]/.test(cmd)) return false;

  // Normalize by stripping balanced surrounding quote pairs (see
  // isTerminalCompleteBypass for rationale). Keeps quoted and unquoted forms
  // tokenizing identically on every Node version / OS.
  const normalized = String(cmd)
    .trim()
    .replace(/"([^"]*)"/g, '$1')
    .replace(/'([^']*)'/g, '$1');

  // Token-based parsing (see isTerminalCompleteBypass for rationale).
  const tokens = normalized.split(/\s+/);
  if (tokens.length < 4) return false;

  const args = extractSessionGuardArgs(tokens);
  if (args === null) return false;

  const resolvedPath = expandPluginRoot(args.scriptPath);
  deps.debugLogCandidatePath(resolvedPath);
  if (!isTrustedScriptPath(resolvedPath, deps.trustedDirs)) return false;

  if (args.targetTicket !== ticketId) return false;

  const state = deps.loadStateFile(ticketId, '.work-state.json');
  return deps.getCurrentStep(state, deps.workSteps) === 'complete';
}

// Step-conditional bypasses shared by Rule 3 and Rule 3b.
function isTerminalBypassAllowed(deps, scriptBase, subCmd, cmd, ticketId, hookData) {
  // work-state.js complete at terminal step (GH-276)
  if (scriptBase === 'work-state.js' && subCmd === 'complete') {
    return isTerminalCompleteBypass(deps, cmd, ticketId, hookData);
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
