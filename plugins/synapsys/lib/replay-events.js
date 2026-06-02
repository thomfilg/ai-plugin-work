'use strict';

/**
 * synapsys-replay — transcript event extraction + walker (extracted to keep
 * the CLI entrypoint under the 400-line quality cap).
 *
 * Public surface (re-exported by scripts/synapsys-replay.js):
 *   - extractEvents(parsedLine)
 *   - parseSince(spec)
 *   - walkTranscripts({since, project, baseDir})
 *   - iterLines(filePath)
 *   - replayEvent(memories, event)
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const matcher = require('./matcher');

// Synthetic user entries emitted by Claude Code (slash-command stdouts,
// system-reminder wrappers, hook output, agent inbox notifications) should not
// be treated as real UserPromptSubmit events — they pollute fire counts and
// FP rates with text the user never typed.
const SYNTHETIC_USER_PREFIXES = [
  '<command-name>',
  '<command-message>',
  '<command-args>',
  '<local-command-stdout>',
  '<system-reminder>',
  '<task-notification>',
  '<bash-stdout>',
  '<bash-stderr>',
];

function isSyntheticUserText(text) {
  if (typeof text !== 'string') return false;
  const head = text.trimStart();
  return SYNTHETIC_USER_PREFIXES.some((p) => head.startsWith(p));
}

function isSyntheticParsedLine(parsedLine) {
  return !!(parsedLine && (parsedLine.isMeta === true || parsedLine.toolUseResult));
}

function joinTextBlocks(content) {
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

function extractUserEvents(message, parsedLine) {
  if (isSyntheticParsedLine(parsedLine)) return [];
  const content = message ? message.content : undefined;
  if (content == null) return [];
  if (typeof content === 'string') {
    return isSyntheticUserText(content) ? [] : [{ event: 'UserPromptSubmit', prompt: content }];
  }
  if (!Array.isArray(content)) return [];
  if (content.some((b) => b && b.type === 'tool_result')) return [];
  const prompt = joinTextBlocks(content);
  if (prompt.length === 0 || isSyntheticUserText(prompt)) return [];
  return [{ event: 'UserPromptSubmit', prompt }];
}

function extractAssistantEvents(message) {
  if (!message || !Array.isArray(message.content)) return [];
  return message.content
    .filter((b) => b && b.type === 'tool_use' && typeof b.name === 'string')
    .map((b) => ({
      event: 'PreToolUse',
      tool: b.name,
      tool_input: b.input,
    }));
}

/**
 * Pure transcript → synthetic-event mapper (Task 2, R2, G1+G2).
 *   - `type=user`      → `{event:'UserPromptSubmit', prompt}`
 *   - `type=assistant` → one `{event:'PreToolUse', tool, tool_input}` per tool_use block
 *   - else → `[]`
 */
function extractEvents(parsedLine) {
  if (!parsedLine || typeof parsedLine !== 'object') return [];
  const { type, message } = parsedLine;
  if (type === 'user') return extractUserEvents(message, parsedLine);
  if (type === 'assistant') return extractAssistantEvents(message);
  return [];
}

/**
 * Convert a `--since=Nd` window string into milliseconds. Throws on invalid
 * format; main()/die() handles user-facing error reporting per spec §CLI.
 */
function parseSince(spec) {
  if (typeof spec !== 'string' || !/^\d+d$/.test(spec)) {
    throw new Error(`invalid --since=${spec} (expected format like 7d, 14d)`);
  }
  const days = Number(spec.slice(0, -1));
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Claude Code stores per-project transcripts under `~/.claude/projects/<hash>`
 * where `<hash>` is the project's absolute path with `/` replaced by `-`.
 */
function cwdToProjectHash(cwd) {
  return cwd.split(path.sep).join('-');
}

function resolveProjectDirs(root, project, { cwd, allProjects } = {}) {
  if (project) {
    const dir = path.join(root, project);
    return fs.existsSync(dir) ? [dir] : [];
  }
  if (!allProjects && cwd) {
    const dir = path.join(root, cwdToProjectHash(cwd));
    return fs.existsSync(dir) ? [dir] : [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => path.join(root, d.name));
}

function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
}

function safeMtimeMs(full) {
  try {
    return fs.statSync(full).mtimeMs;
  } catch {
    return null;
  }
}

function collectRecentJsonl(projDir, cutoff) {
  const entries = safeReadDir(projDir);
  if (!entries) return [];
  const out = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const full = path.join(projDir, entry.name);
    const mtimeMs = safeMtimeMs(full);
    if (mtimeMs !== null && mtimeMs >= cutoff) out.push(full);
  }
  return out;
}

/**
 * Walk `*.jsonl` transcripts under `baseDir` (default `~/.claude/projects/`)
 * whose mtime falls within the `--since` window.
 */
function walkTranscripts({ since, project, baseDir, cwd, allProjects } = {}) {
  const root = baseDir || path.join(os.homedir(), '.claude/projects');
  if (!fs.existsSync(root)) return [];
  const cutoff = Date.now() - parseSince(since || '7d');
  const projectDirs = resolveProjectDirs(root, project, { cwd, allProjects });
  const out = [];
  for (const projDir of projectDirs) {
    out.push(...collectRecentJsonl(projDir, cutoff));
  }
  return out;
}

/**
 * Stream-parse a JSONL transcript file. Yields one parsed object per
 * non-empty line; malformed lines emit a single stderr warning and are
 * skipped (R1).
 */
function* iterLines(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(`synapsys-replay: cannot read ${filePath}: ${err.message}\n`);
    return;
  }
  const lines = raw.split('\n');
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      yield JSON.parse(line);
    } catch (err) {
      process.stderr.write(
        `synapsys-replay: malformed JSONL line in ${filePath} (skipped): ${err.message}\n`
      );
    }
  }
}

function dispatchMatch(memory, event) {
  if (event.event === 'UserPromptSubmit') {
    return matcher.matchPrompt(memory, event.prompt || '');
  }
  if (event.event === 'PreToolUse') {
    return matcher.matchPreTool(memory, {
      tool_name: event.tool,
      tool_input: event.tool_input,
    });
  }
  return { fired: false, reason: 'events-exclude' };
}

/**
 * Replay a synthetic event against every memory and return one tuple per
 * memory: `{memory_name, event, fired, matched_substring}`. Task 4 (R3, G3).
 */
function replayEvent(memories, event) {
  const out = [];
  for (const memory of memories) {
    const result = dispatchMatch(memory, event);
    const matched = result && result.matched ? result.matched : undefined;
    const matched_substring = matched
      ? matched.prompt_substring !== undefined
        ? matched.prompt_substring
        : matched.content_substring
      : undefined;
    out.push({
      memory_name: memory.name,
      event: event.event,
      fired: Boolean(result && result.fired),
      matched_substring,
    });
  }
  return out;
}

module.exports = {
  extractEvents,
  parseSince,
  walkTranscripts,
  iterLines,
  replayEvent,
};
