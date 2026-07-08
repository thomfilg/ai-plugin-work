/**
 * policies/state-script-gate.js
 *
 * Strict Bash-command gating for state scripts, extracted from
 * enforce-step-workflow.js:
 *
 *   - shellTokenize(): quote-aware tokenizer for the strict bypass parser
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

/**
 * Quote-aware shell tokenizer for the strict bypass parser.
 *
 * Splits on whitespace EXCEPT within balanced ASCII single or double quotes,
 * so paths containing spaces (e.g. `/Users/John Smith/...`) remain a single
 * token. Surrounding quotes are stripped from each token before return.
 *
 * Rejects (returns null) on:
 *   - Unbalanced quotes (open `"` or `'` with no matching close).
 *   - Nested/mixed quotes within a token are simply treated literally — we do
 *     not support shell-style escaping (`\"`, `$'..'`, etc.); the bypass is
 *     for the orchestrator's strict, direct invocation only.
 *
 * @param {string} input
 * @returns {string[] | null}
 */
function shellTokenize(input) {
  const tokens = [];
  let current = '';
  let inToken = false;
  let quote = null; // either '"' or "'" when inside a quoted run

  for (let idx = 0; idx < input.length; idx++) {
    const ch = input[idx];

    if (quote) {
      if (ch === quote) {
        quote = null; // close quote — token continues (allows `a"b"c` style)
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      inToken = true;
      continue;
    }

    if (/\s/.test(ch)) {
      if (inToken) {
        tokens.push(current);
        current = '';
        inToken = false;
      }
      continue;
    }

    current += ch;
    inToken = true;
  }

  if (quote) return null; // unbalanced
  if (inToken) tokens.push(current);
  return tokens;
}

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

function makeTrace(enabled) {
  return (reason, extra) => {
    if (enabled) {
      try {
        process.stderr.write(
          `[isTerminalCompleteBypass] ${reason}` +
            (extra ? ` | ${JSON.stringify(extra)}` : '') +
            '\n'
        );
      } catch {
        /* never throw from debug */
      }
    }
  };
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
 *   1. Command is a strict `node <path>/work-state.js complete <ticketId>` invocation
 *   2. No shell operators, substitutions, or extra arguments
 *   3. Target ticket matches the active ticket
 *   4. The workflow is at the terminal `complete` step
 */
function isTerminalCompleteBypass(deps, cmd, ticketId) {
  const DEBUG_BYPASS = process.env.ENFORCE_HOOK_DEBUG === '1';
  const trace = makeTrace(DEBUG_BYPASS);

  // Reject shell operators and substitutions FIRST — cheapest fail-fast.
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
function isTerminalSessionGuardBypass(deps, cmd, ticketId) {
  // Reject shell operators and substitutions FIRST — cheapest fail-fast.
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
function isTerminalBypassAllowed(deps, scriptBase, subCmd, cmd, ticketId) {
  // work-state.js complete at terminal step (GH-276)
  if (scriptBase === 'work-state.js' && subCmd === 'complete') {
    return isTerminalCompleteBypass(deps, cmd, ticketId);
  }
  // session-guard.js finish/reveal/complete at terminal step (GH-338)
  if (
    scriptBase === 'session-guard.js' &&
    (subCmd === 'finish' || subCmd === 'reveal' || subCmd === 'complete')
  ) {
    return isTerminalSessionGuardBypass(deps, cmd, ticketId);
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
function checkUnsafeSubcommands(deps, cmd, ticketId) {
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
    if (isTerminalBypassAllowed(deps, scriptBase, subCmd, cmd, ticketId)) continue;
    return {
      blocked: true,
      message:
        `BLOCKED: Direct Bash call to ${scriptBase} with sub-command '${subCmd}' is not allowed.\n` +
        `State files must only be modified through the orchestrator/workflow-engine scripts.\n`,
    };
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
 */
function createStateScriptGate(deps) {
  return {
    isTerminalCompleteBypass: (cmd, ticketId) => isTerminalCompleteBypass(deps, cmd, ticketId),
    isTerminalSessionGuardBypass: (cmd, ticketId) =>
      isTerminalSessionGuardBypass(deps, cmd, ticketId),
    checkUnsafeSubcommands: (cmd, ticketId) => checkUnsafeSubcommands(deps, cmd, ticketId),
  };
}

module.exports = {
  shellTokenize, // quote-aware tokenizer (exported for reuse/tests)
  createStateScriptGate, // terminal bypasses + Rule 3b sub-command gate
};
