'use strict';

/**
 * transcript-claude.js — the claude project-JSONL reader leg. Consumed via
 * the dispatching facade in transcript.js, never directly by hooks.
 *
 * SECURITY (heimdall unlock invariant): only string content and `text`
 * blocks of `user` records are trusted user text — tool_result content is
 * excluded, same rule as heimdall's reader today.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseLine, textBlocks, addToolEvent, aliasMatch } = require('./transcript-shared');

const CLAUDE_MARKER_TYPES = new Set(['user', 'assistant', 'summary']);

const CLAUDE_INJECTED_RES = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<task-notification>[\s\S]*?<\/task-notification>/g,
];

function claudeUserTexts(entry) {
  if (!entry || entry.type !== 'user' || !entry.message) return [];
  const content = entry.message.content;
  if (typeof content === 'string') return [content];
  return textBlocks(content, 'text');
}

function claudeAssistantText(entry) {
  if (!entry || entry.type !== 'assistant' || !entry.message) return null;
  const content = entry.message.content;
  if (typeof content === 'string') return content || null;
  const parts = textBlocks(content, 'text');
  return parts.length > 0 ? parts.join('\n') : null;
}

function toolResultText(item) {
  const content = item && item.content;
  if (typeof content === 'string') return content;
  return textBlocks(content, 'text').join('\n');
}

function contentItems(entry) {
  if (!entry || !entry.message) return [];
  return Array.isArray(entry.message.content) ? entry.message.content : [];
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

module.exports = {
  CLAUDE_MARKER_TYPES,
  CLAUDE_INJECTED_RES,
  claudeUserTexts,
  claudeAssistantText,
  collectClaudeToolEvents,
  detectClaudeAgentContext,
  listClaudeSessions,
  flattenCwd,
};
