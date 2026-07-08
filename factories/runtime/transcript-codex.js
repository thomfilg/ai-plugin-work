'use strict';

/**
 * transcript-codex.js — the codex session-rollout reader leg. Consumed via
 * the dispatching facade in transcript.js, never directly by hooks.
 *
 * SECURITY (heimdall unlock invariant): codex user text with
 * `authoredOnly:true` comes from `event_msg`/`user_message` records ONLY —
 * `response_item` user-role rows can carry injected AGENTS.md/skill/hook
 * context and `function_call_output` is agent-controlled; neither may ever
 * authorize an unlock.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseLine,
  readFirstLine,
  textBlocks,
  addToolEvent,
  aliasMatch,
} = require('./transcript-shared');

const CODEX_MARKER_TYPES = new Set([
  'session_meta',
  'event_msg',
  'response_item',
  'turn_context',
  'token_count',
  'compacted',
]);

const CODEX_INJECTED_RES = [
  /<environment_context>[\s\S]*?<\/environment_context>/g,
  /<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>/g,
  /<skill>[\s\S]*?<\/skill>/g,
];

/** The only codex user text a security decision may trust (event_msg leg). */
function codexAuthoredUserText(p) {
  if (!p || p.type !== 'user_message') return [];
  return typeof p.message === 'string' ? [p.message] : [];
}

/** response_item user rows — may carry injected context, never trusted. */
function codexInjectedUserTexts(p) {
  if (!p || p.type !== 'message' || p.role !== 'user') return [];
  return textBlocks(p.content, 'input_text');
}

function codexUserTexts(record, authoredOnly) {
  if (!record) return [];
  if (record.type === 'event_msg') return codexAuthoredUserText(record.payload);
  if (authoredOnly || record.type !== 'response_item') return [];
  return codexInjectedUserTexts(record.payload);
}

function codexAssistantText(record) {
  if (!record || record.type !== 'response_item') return null;
  const p = record.payload;
  if (!p || p.type !== 'message' || p.role !== 'assistant') return null;
  const parts = textBlocks(p.content, 'output_text');
  return parts.length > 0 ? parts.join('\n') : null;
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

module.exports = {
  CODEX_MARKER_TYPES,
  CODEX_INJECTED_RES,
  codexUserTexts,
  codexAssistantText,
  collectCodexToolEvents,
  detectCodexAgentContext,
  listCodexSessions,
};
