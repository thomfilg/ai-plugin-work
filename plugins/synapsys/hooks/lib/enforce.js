'use strict';

/**
 * enforce — per-memory `enforce: advise | suggest | block` evaluation for the
 * PreToolUse dispatch (GH-520). Extracted from the dispatcher hook
 * (synapsys.js) to keep that file under the static-gate line budget.
 *
 * Semantics (issue #520):
 *   - advise  — the default; exactly the pre-enforce injection behavior.
 *   - suggest — injection plus a one-line nudge appended (never blocks).
 *   - block   — when the memory's classifier (if declared) also says 'block',
 *               the dispatcher emits a PreToolUse `permissionDecision: 'deny'`
 *               envelope with a structured message and exits 0. First blocking
 *               memory wins (memory list order); a deny response carries ONLY
 *               the deny JSON, no additionalContext mixing.
 *
 * Override: a per-call marker anywhere in the serialized tool_input —
 *   synapsys:override=<memory-name> reason="<10+ char reason>"
 * — allows the call and logs an `override` telemetry event. A reason shorter
 * than 10 chars keeps the block and appends a too-short notice.
 *
 * Fail-open ethos: any throw anywhere in enforcement → plain advise injection
 * (deny: null, no nudges). Subagent-propagated (prompt-scope) matches are
 * skipped: they matched the synthetic Task/Agent prompt, not the tool call
 * under judgment.
 */

const path = require('node:path');
const classifiers = require(path.join(__dirname, '..', '..', 'lib', 'enforce-classifiers'));
const telemetry = require(path.join(__dirname, '..', '..', 'lib', 'telemetry'));

const MIN_REASON_LEN = 10;

// The marker is scanned in JSON.stringify(tool_input), where a quoted reason
// inside a string value serializes as `reason=\"…\"` — hence the optional
// backslash before each delimiter quote.
// Lazy content class: the first (optionally escaped) quote closes the reason,
// so the JSON-escaping backslash of the closing `\"` never leaks into the
// captured reason.
const OVERRIDE_RE =
  /synapsys:override=([A-Za-z0-9][A-Za-z0-9_-]*)\s+reason=\\?"((?:\\.|[^"\\])*?)\\?"/g;

// Scan the serialized tool_input for override markers. Returns a Map of
// memory-name → reason (first occurrence wins). Nothing is stripped from the
// tool input — overrides are observational and per-call.
function scanOverrides(toolInput) {
  const out = new Map();
  try {
    const blob = JSON.stringify(toolInput || {});
    OVERRIDE_RE.lastIndex = 0;
    let m;
    while ((m = OVERRIDE_RE.exec(blob)) !== null) {
      if (!out.has(m[1])) out.set(m[1], m[2]);
    }
  } catch {
    /* fail-open: no overrides */
  }
  return out;
}

function buildDenyMessage(memory, opts) {
  const body = typeof memory.body === 'string' ? memory.body.trim() : '';
  const lines = [
    `[synapsys:block] ${memory.name}`,
    body,
    '',
    'To override, re-issue the SAME tool call including the marker:',
    `  # synapsys:override=${memory.name} reason="<10+ char reason>"`,
    "(in the Bash command or the tool's description field). Overrides are per-call and logged.",
  ];
  if (opts && opts.reasonTooShort) {
    lines.push(
      '',
      'An override marker was found but its reason is too short (< 10 chars) — the block still applies.'
    );
  }
  return lines.join('\n');
}

// Resolve the memory's classifier verdict. No classifier declared → the
// trigger_pretool match IS the classifier ('block'). Unknown classifier name →
// stderr warning + treat the memory as advise. Classifier throw → allow.
function classifierVerdict(memory, payload, sessionId) {
  const name = memory.enforceClassifier || '';
  if (!name) return 'block';
  const fn = classifiers.getClassifier(name);
  if (!fn) {
    process.stderr.write(
      `[synapsys] memory "${memory.name}": unknown enforce_classifier "${name}" — treating as advise\n`
    );
    return 'advise';
  }
  try {
    return fn(memory, payload, { sessionId }) === 'block' ? 'block' : 'allow';
  } catch {
    return 'allow';
  }
}

function suggestNudge(name) {
  return `[synapsys:suggest] ${name} — consider the recommended alternative before proceeding (see memory above)`;
}

// Decide one memory's contribution: null (advise — nothing extra),
// { nudge } (suggest), or { deny } (block that survived classifier + override).
function decideMemory(m, payload, sessionId, overrides) {
  const level = m.enforce || 'advise';
  if (level === 'suggest') return { nudge: suggestNudge(m.name) };
  if (level !== 'block') return null;
  if (classifierVerdict(m, payload, sessionId) !== 'block') return null;
  const reason = overrides.get(m.name);
  if (typeof reason === 'string' && reason.length >= MIN_REASON_LEN) {
    telemetry.recordOverride(m, payload, reason);
    return null;
  }
  telemetry.recordBlock(m, payload);
  return {
    deny: {
      name: m.name,
      message: buildDenyMessage(m, { reasonTooShort: typeof reason === 'string' }),
    },
  };
}

function evaluate(matched, payload, sessionId, subagentNames) {
  const nudges = [];
  const overrides = scanOverrides(payload && payload.tool_input);
  for (const m of matched || []) {
    // Prompt-scope subagent propagations matched the synthetic prompt, not the
    // tool call — never enforce against them.
    if (subagentNames && subagentNames.has(m.name)) continue;
    const decision = decideMemory(m, payload, sessionId, overrides);
    if (!decision) continue;
    // First blocking memory wins; the response is ONLY the deny JSON.
    if (decision.deny) return { deny: decision.deny, nudges: [] };
    nudges.push(decision.nudge);
  }
  return { deny: null, nudges };
}

/**
 * Evaluate enforcement for a PreToolUse dispatch.
 * Returns { deny: null | { name, message }, nudges: string[] }.
 *
 * Also feeds the first-edit-of-session observer (EVERY PreToolUse dispatch,
 * matched or not) — AFTER classification, so the call under judgment never
 * satisfies or consumes its own gate.
 */
function evaluatePreTool(matched, payload, sessionId, subagentNames) {
  let result;
  try {
    result = evaluate(matched, payload, sessionId, subagentNames);
  } catch {
    // Fail-open: any enforcement fault degrades to plain advise injection.
    result = { deny: null, nudges: [] };
  }
  try {
    classifiers.observePreTool(sessionId, payload);
  } catch {
    /* fail-open */
  }
  return result;
}

// Append suggest nudges (one line each) below the rendered injection output.
function appendNudges(output, nudges) {
  if (!Array.isArray(nudges) || nudges.length === 0) return output || '';
  const block = nudges.join('\n');
  return output ? `${output}\n${block}` : block;
}

module.exports = {
  evaluatePreTool,
  appendNudges,
  // Exposed for unit tests.
  scanOverrides,
  buildDenyMessage,
};
