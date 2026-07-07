// GENERATED — edit factories/runtime/payload.js and run scripts/sync-vendored.js

'use strict';

/**
 * payload.js — normalize the two runtimes' hook stdin payloads into ONE shape
 * (CanonicalHookEvent) that every ported hook script consumes.
 *
 * All reads are payload-first (`session_id`, `cwd`, `tool_input`, `agent_type`)
 * with the legacy CLAUDE_* env vars as fallback only — codex sets none of them
 * (ground truth §2.7.2) and payload-first is also more correct on Claude.
 *
 * tool_response tolerance (probe P4): string (codex Bash/apply_patch), object
 * (claude Bash {stdout, stderr, …}), or a LIST of content blocks (codex
 * view_image) — list-shaped responses normalize to '' with the raw value
 * preserved under `native`.
 */

const { canonicalToolKind, extractWriteTargets } = require('./tools');

const APPLY_PATCH_EXIT_RE = /^Exit code: (-?\d+)/;

function str(value) {
  return typeof value === 'string' && value !== '' ? value : null;
}

function resolveEvent(raw, opts) {
  return (
    (opts && opts.event) || str(raw.hook_event_name) || str(process.env.CLAUDE_HOOK_TYPE) || null
  );
}

function responseText(resp) {
  if (typeof resp === 'string') return resp;
  if (Array.isArray(resp)) return '';
  if (resp && typeof resp === 'object') {
    if ('stdout' in resp || 'stderr' in resp) {
      return [resp.stdout, resp.stderr].filter((s) => typeof s === 'string' && s !== '').join('\n');
    }
    try {
      return JSON.stringify(resp);
    } catch {
      return '';
    }
  }
  return String(resp);
}

function coerceExitCode(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
  return null;
}

/**
 * Exit code, locked read order mirroring synapsys matcher-posttool:
 * tool_response.exit_code → tool_response.exitCode → payload.exit_code; then
 * the codex apply_patch string form ("Exit code: N\nWall time: …"). Codex Bash
 * responses carry no exit code ⇒ null.
 */
function resolveToolExitCode(raw) {
  const resp = raw.tool_response;
  if (resp && typeof resp === 'object' && !Array.isArray(resp)) {
    const fromResp = coerceExitCode(resp.exit_code);
    if (fromResp !== null) return fromResp;
    const fromCamel = coerceExitCode(resp.exitCode);
    if (fromCamel !== null) return fromCamel;
  }
  const fromPayload = coerceExitCode(raw.exit_code);
  if (fromPayload !== null) return fromPayload;
  if (raw.tool_name === 'apply_patch' && typeof resp === 'string') {
    const parsed = resp.match(APPLY_PATCH_EXIT_RE);
    if (parsed) return Number(parsed[1]);
  }
  return null;
}

function resolveAgent(raw) {
  return {
    id: str(raw.agent_id),
    type:
      str(raw.agent_type) ||
      str(process.env.CLAUDE_AGENT_TYPE) ||
      str(process.env.CLAUDE_CURRENT_AGENT),
  };
}

function resolveSessionId(raw) {
  return (
    str(raw.session_id) ||
    str(process.env.CLAUDE_CODE_SESSION_ID) ||
    str(process.env.AGENT_SESSION_ID)
  );
}

/**
 * Normalize a raw hook payload into a CanonicalHookEvent.
 *
 * @param {object} raw - parsed hook stdin JSON (either runtime's shape)
 * @param {{event?: string, runtime?: string}} [opts]
 */
function normalizeHookPayload(raw, opts = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const runtime = opts.runtime || 'claude';
  const rawToolName = str(src.tool_name);
  const toolKind = rawToolName ? canonicalToolKind(rawToolName, runtime) : null;
  const toolInput = src.tool_input && typeof src.tool_input === 'object' ? src.tool_input : null;
  const shellCommand =
    toolKind === 'shell' && toolInput && typeof toolInput.command === 'string'
      ? toolInput.command
      : null;

  return {
    runtime,
    event: resolveEvent(src, opts),
    sessionId: resolveSessionId(src),
    turnId: str(src.turn_id),
    cwd: str(src.cwd) || process.cwd(),
    transcriptPath: str(src.transcript_path),
    permissionMode: str(src.permission_mode),
    prompt: typeof src.prompt === 'string' ? src.prompt : null,
    rawToolName,
    toolKind,
    toolInput,
    shellCommand,
    writeTargets: rawToolName ? extractWriteTargets(rawToolName, toolInput || {}, runtime) : [],
    toolResponseText: src.tool_response == null ? null : responseText(src.tool_response),
    toolExitCode: resolveToolExitCode(src),
    agent: resolveAgent(src),
    stopHookActive: src.stop_hook_active === true,
    lastAssistantText:
      typeof src.last_assistant_message === 'string' ? src.last_assistant_message : null,
    source: str(src.source),
    trigger: str(src.trigger),
    native: src,
  };
}

/**
 * Whether the event fired inside a subagent. Claude: transcript under
 * /subagents/ or CLAUDE_CURRENT_AGENT set. Codex: payload agent identity
 * (agent_id/agent_type present when inside a subagent — ground truth §2.5.1).
 */
function isSubagentContext(evt) {
  if (!evt || typeof evt !== 'object') return false;
  if (evt.runtime === 'codex') return Boolean(evt.agent && (evt.agent.id || evt.agent.type));
  return (
    (typeof evt.transcriptPath === 'string' && evt.transcriptPath.includes('/subagents/')) ||
    Boolean(process.env.CLAUDE_CURRENT_AGENT)
  );
}

module.exports = { normalizeHookPayload, isSubagentContext };
