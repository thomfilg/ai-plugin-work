'use strict';

/**
 * transcript.js — dual-format transcript reader facade (claude project JSONL
 * vs codex session rollouts). Format is SNIFFED per file, never trusted from
 * the runtime flag: a codex rollout opens with a `session_meta` record;
 * claude transcripts contain `user`/`assistant`/`summary` records (real files
 * open with bookkeeping lines like `last-prompt`/`mode`, so the sniff scans
 * the first lines for the first recognizable marker instead of trusting
 * line 1).
 *
 * The per-format readers live in transcript-claude.js / transcript-codex.js
 * (shared JSONL helpers in transcript-shared.js); each leg documents its own
 * trusted-text security rules. This facade is the only module hooks require.
 *
 * Readers return empty results with an `unavailable: true` marker property on
 * unknown formats so callers can degrade per the C7 contract.
 */

const { readLines, parseLine } = require('./transcript-shared');
const claude = require('./transcript-claude');
const codex = require('./transcript-codex');

const SNIFF_LINE_LIMIT = 50;

function markUnavailable(result) {
  result.unavailable = true;
  return result;
}

/** 'claude' | 'codex' | 'unknown' for a transcript file on disk. */
function sniffFormat(filePath) {
  const lines = filePath ? readLines(filePath) : null;
  if (!lines) return 'unknown';
  for (const line of lines.slice(0, SNIFF_LINE_LIMIT)) {
    const parsed = parseLine(line);
    if (!parsed || typeof parsed.type !== 'string') continue;
    if (codex.CODEX_MARKER_TYPES.has(parsed.type)) return 'codex';
    if (claude.CLAUDE_MARKER_TYPES.has(parsed.type)) return 'claude';
  }
  return 'unknown';
}

/**
 * Last `count` user messages. `authoredOnly` (default true) restricts codex
 * extraction to event_msg/user_message records — the only user text a
 * security decision may trust.
 */
function readUserMessages(filePath, { count = 20, authoredOnly = true } = {}) {
  const format = sniffFormat(filePath);
  if (format === 'unknown') return markUnavailable([]);
  const messages = [];
  for (const line of readLines(filePath) || []) {
    const entry = parseLine(line);
    if (!entry) continue;
    if (format === 'claude') messages.push(...claude.claudeUserTexts(entry));
    else messages.push(...codex.codexUserTexts(entry, authoredOnly));
  }
  return messages.slice(-count);
}

/** Stop payloads carry the answer inline; fall back to the transcript path. */
function payloadAssistantText(payload) {
  if (typeof payload.last_assistant_message === 'string') return payload.last_assistant_message;
  if (typeof payload.lastAssistantText === 'string') return payload.lastAssistantText;
  return readLastAssistantText(payload.transcript_path || payload.transcriptPath);
}

/**
 * Last assistant prose. Accepts a payload object (Stop payloads prefer
 * `last_assistant_message`) or a transcript path.
 */
function readLastAssistantText(pathOrPayload) {
  if (pathOrPayload && typeof pathOrPayload === 'object') {
    return payloadAssistantText(pathOrPayload);
  }
  const format = sniffFormat(pathOrPayload);
  if (format === 'unknown') return null;
  const lines = readLines(pathOrPayload) || [];
  const extract = format === 'claude' ? claude.claudeAssistantText : codex.codexAssistantText;
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = extract(parseLine(lines[i]));
    if (text) return text;
  }
  return null;
}

/**
 * Tool invocations with their outputs joined (claude tool_use/tool_result by
 * id; codex function_call/function_call_output by call_id). Codex shell-like
 * names normalize to 'Bash' so cross-runtime filters work; the native name is
 * kept as `rawName`.
 */
function readToolEvents(filePath, { toolName } = {}) {
  const format = sniffFormat(filePath);
  if (format === 'unknown') return markUnavailable([]);
  const lines = readLines(filePath) || [];
  const events = [];
  const byId = new Map();
  if (format === 'claude') claude.collectClaudeToolEvents(lines, events, byId);
  else codex.collectCodexToolEvents(lines, events, byId);
  if (!toolName) return events;
  return events.filter((e) => e.name === toolName || e.rawName === toolName);
}

/**
 * Whether the transcript shows an ACTIVE dispatch of one of the given agent
 * aliases (claude: most recent Task/Agent tool_use without a tool_result;
 * codex: most recent spawn_agent call without its function_call_output).
 */
function detectAgentContext(filePath, aliases) {
  const format = sniffFormat(filePath);
  if (format === 'unknown') return false;
  const lines = readLines(filePath) || [];
  if (format === 'claude') return claude.detectClaudeAgentContext(lines, aliases);
  return codex.detectCodexAgentContext(lines, aliases);
}

/**
 * Session transcripts recorded for `cwd`, newest first. Codex leg walks
 * `<root>/YYYY/MM/DD/rollout-*.jsonl` reading only line-1 session_meta.cwd;
 * claude leg lists `<root>/<flattened-cwd>/*.jsonl`.
 */
function listSessionsForCwd(cwd, { root, maxAgeDays = 14, runtime = 'codex' } = {}) {
  const opts = { root, maxAgeDays };
  return runtime === 'claude'
    ? claude.listClaudeSessions(cwd, opts)
    : codex.listCodexSessions(cwd, opts);
}

/** Strip runtime-injected blocks from a message before matching against it. */
function stripInjected(text, format) {
  let out = String(text == null ? '' : text);
  const patterns = format === 'codex' ? codex.CODEX_INJECTED_RES : claude.CLAUDE_INJECTED_RES;
  for (const re of patterns) out = out.replace(re, '');
  return out.trim();
}

module.exports = {
  sniffFormat,
  readUserMessages,
  readLastAssistantText,
  readToolEvents,
  detectAgentContext,
  listSessionsForCwd,
  stripInjected,
  flattenCwd: claude.flattenCwd,
};
