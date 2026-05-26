/**
 * policies/command-matching.js
 *
 * Pure command/tool matching primitives extracted from enforce-step-workflow.js.
 *
 * Provides:
 *   - NODE_INVOKE_PATTERN_SRC: regex source for finding node script invocations in Bash
 *   - getNodeInvocations(cmd): match all node script invocations in a command
 *   - buildCommandIndex(commandMap): pre-index a workflow's commandMap by tool name
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
const NODE_INVOKE_PATTERN_SRC =
  '(?:^|&&|;|\\|)\\s*' +
  // Optional wrapper commands (timeout, nice, env). All consume their args.
  '(?:timeout\\s+\\d+(?:\\.\\d+)?[smhdSMHD]?\\s+|' +
  'nice(?:\\s+-n\\s+-?\\d+)?\\s+|' +
  'env(?:\\s+[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|\'[^\']*\'|\\S+))*\\s+' +
  ')*' +
  // Inline env-assignments (FOO=bar BAZ=qux node ...).
  '(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|\'[^\']*\'|\\S+)\\s+)*' +
  '(?:node|nodejs)\\s+' +
  '(?:(?:--(?:require|loader|experimental-loader|import|input-type|conditions|inspect-brk|inspect|inspect-port)|-[rCi])\\s+\\S+\\s+|(?:-[^\\s]+\\s+))*' +
  '(?:"([^"]+)"|\'([^\']+)\'|(\\S+))';

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
 * Match a tool call to a workflow step using the pre-indexed command map.
 * Returns the step name or null if no match.
 */
function matchToolToStep(toolName, toolInput, commandIndex) {
  const mappings = commandIndex[toolName];
  if (!mappings) return null;

  for (const mapping of mappings) {
    // Tool-only match (no field pattern needed)
    if (mapping.field === null) return mapping.step;

    // Safer field coercion — handle non-string values
    const raw = toolInput?.[mapping.field];
    const value = typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw);
    if (mapping.pattern && mapping.pattern.test(value)) return mapping.step;
  }
  return null;
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
  matchToolToStep,
  isExempt,
  parseTransition,
};
