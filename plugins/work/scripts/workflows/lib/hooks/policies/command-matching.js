/**
 * policies/command-matching.js
 *
 * Pure command/tool matching primitives extracted from enforce-step-workflow.js.
 *
 * Provides:
 *   - NODE_INVOKE_PATTERN_SRC: regex source for finding node script invocations in Bash
 *   - getNodeInvocations(cmd): match all node script invocations in a command
 *   - buildCommandIndex(commandMap): pre-index a workflow's commandMap by tool name
 *   - matchToolToMapping(toolName, toolInput, commandIndex): map a tool call to a commandMap entry
 *   - matchToolToStep(toolName, toolInput, commandIndex): map a tool call to a step
 *   - isExempt(toolName, toolInput, exemptPatterns): check workflow exemptions
 *   - parseTransition(toolName, toolInput, transitionPattern, sanitize): parse transition cmd
 *
 * No I/O, no state, no logging. Safe to test in isolation.
 */

// Shared regex source for detecting node script invocations in Bash commands (GH-89).
// Handles: cd && node ..., env prefixes, Node flags (including multi-arg like --require <path>),
// quoted paths. --eval/--print/-e/-p excluded (inline code, not file paths).
// Use getNodeInvocations() helper to catch ALL invocations in chained commands.
// Wrapper-aware: matches `timeout <N>[s|m|h] node ...`, `nice [-n N] node ...`,
// and bare `env [VAR=val ...] node ...` in addition to inline env-assignment.
// Without this, agents using `timeout 90 node task-next.js ...` silently bypass
// Rule 5 because the regex didn't recognize the wrapped invocation as a node call.
// Command separators include newline/CR: multi-line Bash (e.g. `cd dir\nnode ...`)
// must be parsed too — otherwise the node call after a newline is invisible, which
// both breaks legitimate exemptions and lets newline-separated invocations evade
// Rules 3b/5.
// Payload-wrapper-aware: a runner handed to `tmux new-session -d -s <name>
// "node …"` (the sanctioned escape for a script that outlives the Bash timeout)
// or to `bash -lc "node …"` is the SAME invocation as the direct call. The
// detection side already sees through the quotes — protect-script-bypass's
// INTERPRETER_PATTERN matches `node <path>` anywhere in the command — so
// without the same reach here the two sides disagree: Vector 3 finds the
// script and blocks it, while isExemptScriptInvocation() sees no node call at
// all and cannot exempt it. That asymmetry is what made a tmux-wrapped
// follow-up-next.js blocked while the identical direct call was allowed.
// Reading INTO the payload also closes the mirror-image hole in Rules 3b/5,
// where wrapping a gated invocation in tmux hid it from the gate.
const NODE_INVOKE_PATTERN_SRC =
  '(?:^|&&|;|\\||\\n|\\r)\\s*' +
  // Optional payload wrapper: a command that carries the real invocation
  // inside a quoted argument (tmux new-session/new-window, bash -c, sh -c).
  // The pre-quote run excludes quotes and command separators so the group can
  // never swallow a neighbouring command, and the opening quote is REQUIRED —
  // an unquoted `bash script.sh` does not enter this branch.
  '(?:(?:tmux|bash|sh|zsh)\\s+[^"\'|;&\\n\\r]*["\'])?\\s*' +
  // Optional wrapper commands (timeout, nice, env). All consume their args.
  '(?:timeout\\s+\\d+(?:\\.\\d+)?[smhdSMHD]?\\s+|' +
  'nice(?:\\s+-n\\s+-?\\d+)?\\s+|' +
  'env(?:\\s+[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|\'[^\']*\'|\\S+))*\\s+' +
  ')*' +
  // Inline env-assignments (FOO=bar BAZ=qux node ...).
  '(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|\'[^\']*\'|\\S+)\\s+)*' +
  '(?:node|nodejs)\\s+' +
  '(?:(?:--(?:require|loader|experimental-loader|import|input-type|conditions|inspect-brk|inspect|inspect-port)|-[rCi])\\s+\\S+\\s+|(?:-[^\\s]+\\s+))*' +
  // Unquoted path: stop at a quote as well as whitespace. Inside a wrapper
  // payload the closing quote abuts the last token (`… follow-up-next.js"`),
  // and a bare path never contains one.
  '(?:"([^"]+)"|\'([^\']+)\'|([^\\s"\']+))';

/** Return all node-script invocations from a command string. */
function getNodeInvocations(cmd) {
  return [...String(cmd || '').matchAll(new RegExp(NODE_INVOKE_PATTERN_SRC, 'g'))];
}

/**
 * Pre-index a workflow's commandMap by tool name for O(1) lookup.
 * Verify-only entries (no `tool` field) are skipped — they're handled by transition verify().
 */
function buildCommandIndex(commandMap) {
  const index = {};
  for (const mapping of commandMap) {
    if (!mapping.tool) continue;
    const tools = Array.isArray(mapping.tool) ? mapping.tool : [mapping.tool];
    for (const tool of tools) {
      if (!index[tool]) index[tool] = [];
      index[tool].push(mapping);
    }
  }
  return index;
}

/**
 * Match a tool call to a commandMap entry using the pre-indexed map.
 * Returns the matched mapping (so callers can read flags such as `advisory`)
 * or null if nothing matches.
 */
function matchToolToMapping(toolName, toolInput, commandIndex) {
  const mappings = commandIndex[toolName];
  if (!mappings) return null;

  for (const mapping of mappings) {
    // Tool-only match (no field pattern needed)
    if (mapping.field === null) return mapping;

    // Safer field coercion — handle non-string values
    const raw = toolInput?.[mapping.field];
    const value = typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw);
    if (mapping.pattern && mapping.pattern.test(value)) return mapping;
  }
  return null;
}

/**
 * Match a tool call to a workflow step using the pre-indexed command map.
 * Returns the step name or null if no match.
 */
function matchToolToStep(toolName, toolInput, commandIndex) {
  return matchToolToMapping(toolName, toolInput, commandIndex)?.step ?? null;
}

/**
 * Check if a Bash command matches any of the workflow's exempt patterns.
 */
function isExempt(toolName, toolInput, exemptPatterns) {
  if (toolName !== 'Bash') return false;
  const cmd = String(toolInput?.command || '');
  return exemptPatterns.some((p) => p.test(cmd));
}

/**
 * Parse a transition command for a specific workflow.
 * Returns { isTransition: true, ticket, targetStep, raw } or { isTransition: false }.
 *
 * @param {string} toolName
 * @param {object} toolInput
 * @param {RegExp} transitionPattern — must capture (ticket, targetStep)
 * @param {(rawTicket: string) => string} [sanitizeTicket] — optional ticket id sanitizer
 */
function parseTransition(toolName, toolInput, transitionPattern, sanitizeTicket) {
  if (toolName !== 'Bash') return { isTransition: false };
  const cmd = String(toolInput?.command || '');
  const match = cmd.match(transitionPattern);
  if (!match) return { isTransition: false };
  const rawTicket = match[1];
  const safeTicket = typeof sanitizeTicket === 'function' ? sanitizeTicket(rawTicket) : rawTicket;
  return { isTransition: true, ticket: safeTicket, targetStep: match[2], raw: cmd };
}

module.exports = {
  NODE_INVOKE_PATTERN_SRC,
  getNodeInvocations,
  buildCommandIndex,
  matchToolToMapping,
  matchToolToStep,
  isExempt,
  parseTransition,
};
