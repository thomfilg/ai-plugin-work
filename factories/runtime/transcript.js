'use strict';

/**
 * transcript.js — dual-format transcript reader (claude project JSONL vs
 * codex session rollouts). Format is SNIFFED per file, never trusted from the
 * runtime flag: a codex rollout opens with a `session_meta` record; claude
 * transcripts contain `user`/`assistant`/`summary` records (real files open
 * with bookkeeping lines like `last-prompt`/`mode`, so the sniff scans the
 * first lines for the first recognizable marker instead of trusting line 1).
 *
 * SECURITY (heimdall unlock invariant): codex user text with
 * `authoredOnly:true` comes from `event_msg`/`user_message` records ONLY —
 * `response_item` user-role rows can carry injected AGENTS.md/skill/hook
 * context and `function_call_output` is agent-controlled; neither may ever
 * authorize an unlock. On claude, only string content and `text` blocks are
 * trusted (tool_result excluded) — same rule as heimdall's reader today.
 *
 * Readers return empty results with an `unavailable: true` marker property on
 * unknown formats so callers can degrade per the C7 contract.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CODEX_MARKER_TYPES = new Set([
  'session_meta',
  'event_msg',
  'response_item',
  'turn_context',
  'token_count',
  'compacted',
]);
const CLAUDE_MARKER_TYPES = new Set(['user', 'assistant', 'summary']);
const SNIFF_LINE_LIMIT = 50;
const FIRST_LINE_BYTE_CAP = 1024 * 1024;

function readLines(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  } catch {
    return null;
  }
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

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
    if (CODEX_MARKER_TYPES.has(parsed.type)) return 'codex';
    if (CLAUDE_MARKER_TYPES.has(parsed.type)) return 'claude';
  }
  return 'unknown';
}

function claudeUserTexts(entry) {
  if (!entry || entry.type !== 'user' || !entry.message) return [];
  const content = entry.message.content;
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.filter((i) => i && i.type === 'text' && i.text).map((i) => i.text);
}

function codexUserTexts(record, authoredOnly) {
  if (!record) return [];
  if (record.type === 'event_msg') {
    const p = record.payload;
    return p && p.type === 'user_message' && typeof p.message === 'string' ? [p.message] : [];
  }
  if (authoredOnly || record.type !== 'response_item') return [];
  const p = record.payload;
  if (!p || p.type !== 'message' || p.role !== 'user' || !Array.isArray(p.content)) return [];
  return p.content.filter((c) => c && c.type === 'input_text' && c.text).map((c) => c.text);
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
    if (format === 'claude') messages.push(...claudeUserTexts(entry));
    else messages.push(...codexUserTexts(entry, authoredOnly));
  }
  return messages.slice(-count);
}

function claudeAssistantText(entry) {
  if (!entry || entry.type !== 'assistant' || !entry.message) return null;
  const content = entry.message.content;
  if (typeof content === 'string') return content || null;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((c) => c && c.type === 'text' && c.text).map((c) => c.text);
  return parts.length > 0 ? parts.join('\n') : null;
}

function codexAssistantText(record) {
  if (!record || record.type !== 'response_item') return null;
  const p = record.payload;
  if (!p || p.type !== 'message' || p.role !== 'assistant' || !Array.isArray(p.content)) {
    return null;
  }
  const parts = p.content.filter((c) => c && c.type === 'output_text' && c.text).map((c) => c.text);
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Last assistant prose. Accepts a payload object (Stop payloads prefer
 * `last_assistant_message`) or a transcript path.
 */
function readLastAssistantText(pathOrPayload) {
  if (pathOrPayload && typeof pathOrPayload === 'object') {
    if (typeof pathOrPayload.last_assistant_message === 'string') {
      return pathOrPayload.last_assistant_message;
    }
    if (typeof pathOrPayload.lastAssistantText === 'string') return pathOrPayload.lastAssistantText;
    return readLastAssistantText(pathOrPayload.transcript_path || pathOrPayload.transcriptPath);
  }
  const format = sniffFormat(pathOrPayload);
  if (format === 'unknown') return null;
  const lines = readLines(pathOrPayload) || [];
  const extract = format === 'claude' ? claudeAssistantText : codexAssistantText;
  for (let i = lines.length - 1; i >= 0; i--) {
    const text = extract(parseLine(lines[i]));
    if (text) return text;
  }
  return null;
}

function toolResultText(item) {
  const content = item && item.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('\n');
}

function contentItems(entry) {
  if (!entry || !entry.message) return [];
  return Array.isArray(entry.message.content) ? entry.message.content : [];
}

function addToolEvent(event, events, byId) {
  events.push(event);
  if (event.id) byId.set(event.id, event);
}

function collectClaudeItem(entryType, item, events, byId) {
  if (entryType === 'assistant' && item && item.type === 'tool_use') {
    addToolEvent(
      { id: item.id || null, name: item.name, input: item.input ?? null, output: null },
      events,
      byId
    );
  } else if (entryType === 'user' && item && item.type === 'tool_result') {
    const event = byId.get(item.tool_use_id);
    if (event) event.output = toolResultText(item);
  }
}

function collectClaudeToolEvents(lines, events, byId) {
  for (const line of lines) {
    const entry = parseLine(line);
    for (const item of contentItems(entry)) collectClaudeItem(entry.type, item, events, byId);
  }
}

const CODEX_SHELL_NAMES = new Set(['exec_command', 'shell', 'shell_command', 'unified_exec']);

function normalizeCodexToolName(name) {
  return CODEX_SHELL_NAMES.has(name) ? 'Bash' : name;
}

function parseCallArguments(args) {
  if (typeof args !== 'string') return args ?? null;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

function collectCodexRecord(p, events, byId) {
  if (p.type === 'function_call') {
    addToolEvent(
      {
        id: p.call_id || null,
        name: normalizeCodexToolName(p.name),
        rawName: p.name,
        input: parseCallArguments(p.arguments),
        output: null,
      },
      events,
      byId
    );
  } else if (p.type === 'function_call_output') {
    const event = byId.get(p.call_id);
    if (event) event.output = typeof p.output === 'string' ? p.output : '';
  }
}

function collectCodexToolEvents(lines, events, byId) {
  for (const line of lines) {
    const record = parseLine(line);
    if (record && record.type === 'response_item' && record.payload) {
      collectCodexRecord(record.payload, events, byId);
    }
  }
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
  if (format === 'claude') collectClaudeToolEvents(lines, events, byId);
  else collectCodexToolEvents(lines, events, byId);
  if (!toolName) return events;
  return events.filter((e) => e.name === toolName || e.rawName === toolName);
}

function normalizeAgentAlias(name) {
  return String(name || '')
    .replace(/^[\w-]+:/, '')
    .toLowerCase();
}

function aliasMatch(value, aliases) {
  if (!value) return false;
  const normalized = normalizeAgentAlias(value);
  return aliases.some((alias) => normalizeAgentAlias(alias) === normalized);
}

function claudeAgentDispatch(entry, aliases) {
  if (!entry || entry.type !== 'assistant' || !entry.message) return null;
  const content = Array.isArray(entry.message.content) ? entry.message.content : [];
  return (
    content.find(
      (item) =>
        item &&
        item.type === 'tool_use' &&
        (item.name === 'Task' || item.name === 'Agent') &&
        aliasMatch(item.input && item.input.subagent_type, aliases)
    ) || null
  );
}

function claudeHasToolResult(lines, startIdx, toolUseId) {
  return lines.slice(startIdx + 1).some((line) => {
    const entry = parseLine(line);
    if (!entry || entry.type !== 'user' || !entry.message) return false;
    const content = Array.isArray(entry.message.content) ? entry.message.content : [];
    return content.some(
      (item) => item && item.type === 'tool_result' && item.tool_use_id === toolUseId
    );
  });
}

function detectClaudeAgentContext(lines, aliases) {
  for (const line of lines.slice(0, 10)) {
    const entry = parseLine(line);
    if (entry && entry.attributionAgent) return aliasMatch(entry.attributionAgent, aliases);
  }
  const recent = lines.slice(-200);
  for (let i = recent.length - 1; i >= 0; i--) {
    const dispatch = claudeAgentDispatch(parseLine(recent[i]), aliases);
    if (dispatch) return !claudeHasToolResult(recent, i, dispatch.id);
  }
  return false;
}

function codexSpawnMatches(payload, aliases) {
  if (payload.type !== 'function_call' || payload.name !== 'spawn_agent') return false;
  const args = parseCallArguments(payload.arguments);
  if (!args || typeof args !== 'object') return false;
  return [args.agent_type, args.task_name, args.name].some((v) => aliasMatch(v, aliases));
}

function detectCodexAgentContext(lines, aliases) {
  const completed = new Set();
  for (let i = lines.length - 1; i >= 0; i--) {
    const record = parseLine(lines[i]);
    if (!record || record.type !== 'response_item' || !record.payload) continue;
    const p = record.payload;
    if (p.type === 'function_call_output' && p.call_id) completed.add(p.call_id);
    if (codexSpawnMatches(p, aliases)) return !completed.has(p.call_id);
  }
  return false;
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
  if (format === 'claude') return detectClaudeAgentContext(lines, aliases);
  return detectCodexAgentContext(lines, aliases);
}

function readFirstLine(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(FIRST_LINE_BYTE_CAP);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const chunk = buffer.toString('utf8', 0, bytes);
    const newline = chunk.indexOf('\n');
    return newline === -1 ? chunk : chunk.slice(0, newline);
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

/** Claude project-dir encoding of a cwd (matches maestro's resume probe). */
function flattenCwd(cwd) {
  return path.resolve(cwd).replace(/[^A-Za-z0-9-]/g, '-');
}

function listClaudeSessions(cwd, { root, maxAgeDays }) {
  const dir = path.join(root || path.join(os.homedir(), '.claude', 'projects'), flattenCwd(cwd));
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => {
      const full = path.join(dir, name);
      try {
        return { path: full, mtime: fs.statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && entry.mtime >= cutoff)
    .sort((a, b) => b.mtime - a.mtime)
    .map((entry) => entry.path);
}

function readNumericDirs(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => /^\d+$/.test(name));
  } catch {
    return [];
  }
}

function listDayDirs(root, cutoff) {
  const days = [];
  for (const year of readNumericDirs(root)) {
    for (const month of readNumericDirs(path.join(root, year))) {
      for (const day of readNumericDirs(path.join(root, year, month))) {
        const endOfDay = new Date(Number(year), Number(month) - 1, Number(day) + 1).getTime();
        if (endOfDay >= cutoff) days.push(path.join(root, year, month, day));
      }
    }
  }
  return days;
}

function rolloutMatchesCwd(filePath, resolvedCwd) {
  const meta = parseLine(readFirstLine(filePath) || '');
  return Boolean(
    meta && meta.type === 'session_meta' && meta.payload && meta.payload.cwd === resolvedCwd
  );
}

function listCodexSessions(cwd, { root, maxAgeDays }) {
  const base = root || path.join(os.homedir(), '.codex', 'sessions');
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const resolvedCwd = path.resolve(cwd);
  const matches = [];
  for (const dayDir of listDayDirs(base, cutoff)) {
    let names;
    try {
      names = fs.readdirSync(dayDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) continue;
      const full = path.join(dayDir, name);
      if (rolloutMatchesCwd(full, resolvedCwd)) matches.push(full);
    }
  }
  return matches.sort((a, b) => (path.basename(a) < path.basename(b) ? 1 : -1));
}

/**
 * Session transcripts recorded for `cwd`, newest first. Codex leg walks
 * `<root>/YYYY/MM/DD/rollout-*.jsonl` reading only line-1 session_meta.cwd;
 * claude leg lists `<root>/<flattened-cwd>/*.jsonl`.
 */
function listSessionsForCwd(cwd, { root, maxAgeDays = 14, runtime = 'codex' } = {}) {
  const opts = { root, maxAgeDays };
  return runtime === 'claude' ? listClaudeSessions(cwd, opts) : listCodexSessions(cwd, opts);
}

const CLAUDE_INJECTED_RES = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
];

const CODEX_INJECTED_RES = [
  /<environment_context>[\s\S]*?<\/environment_context>/g,
  /<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g,
  /<skill>[\s\S]*?<\/skill>/g,
];

/** Strip runtime-injected blocks from a message before matching against it. */
function stripInjected(text, format) {
  let out = String(text == null ? '' : text);
  const patterns = format === 'codex' ? CODEX_INJECTED_RES : CLAUDE_INJECTED_RES;
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
  flattenCwd,
};
