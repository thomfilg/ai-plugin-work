'use strict';

/**
 * Payload / flag-resolution helpers for synapsys-explain, extracted from the
 * CLI so that file stays under the quality gate's max-lines budget. Behavior is
 * IDENTICAL to the originals — pure relocation. The JSON-misconfig parsers take
 * a `die(msg, code)` callback so the CLI keeps owning its exit-code policy.
 */

// Parse a --tool-input JSON flag. Lenient empty handling (absent / '' / bare
// flag → undefined). Invalid JSON is a misconfiguration (exit 2 via `die`).
function parseToolInput(raw, die) {
  if (raw === undefined || raw === '' || raw === true) return undefined;
  try {
    return JSON.parse(raw);
  } catch (err) {
    die(`invalid --tool-input JSON: ${err.message}`, 2);
  }
  return undefined;
}

// Resolve tool_input with a flag fallback: --tool-input wins, else carry the
// raw stdin payload's tool_input, else undefined.
function resolveToolInput(flag, stdinPayload, die) {
  if (flag('tool-input') !== undefined) return parseToolInput(flag('tool-input'), die);
  if (stdinPayload.tool_input !== undefined) return stdinPayload.tool_input;
  return undefined;
}

// Parse a --tool-response flag value. PostToolUse responses are commonly an
// object (e.g. { stdout, stderr, exit_code }) so a JSON value is parsed to drive
// both the content gates and the exit-code gate; a non-JSON value passes through
// verbatim as the string tool_response surface. Mirrors parseToolInput's lenient
// empty handling.
function parseToolResponse(raw) {
  if (raw === undefined || raw === '' || raw === true) return '';
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// Resolve tool_response with a flag fallback so flag-only --event=PostToolUse
// runs (no --stdin) still exercise the content/exit gates instead of failing
// closed. --tool-response wins when provided; otherwise carry through the raw
// stdin payload's tool_response. Mirrors the --tool/--response resolution order.
function resolveToolResponse(flag, stdinPayload) {
  if (flag('tool-response') !== undefined) return parseToolResponse(flag('tool-response'));
  return stdinPayload.tool_response;
}

function buildPayload(event, prompt, tool, toolInput, cwd, response, toolResponse) {
  return {
    hook_event_name: event,
    prompt: prompt === true ? '' : prompt || '',
    tool_name: tool === true ? '' : tool || '',
    tool_input: toolInput || {},
    // PostToolUse matching inspects the tool OUTPUT surface (tool_response +
    // exit code). Carry it through from the raw stdin payload so matchPostTool
    // sees the same shape the dispatcher hook would.
    tool_response: toolResponse,
    response: response === true ? '' : response || '',
    cwd,
  };
}

module.exports = {
  parseToolInput,
  resolveToolInput,
  parseToolResponse,
  resolveToolResponse,
  buildPayload,
};
