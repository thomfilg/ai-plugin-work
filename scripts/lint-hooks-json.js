#!/usr/bin/env node
'use strict';

/**
 * lint-hooks-json — static gate for every plugin's `hooks/hooks.json`.
 *
 * One hooks.json serves both runtimes (Claude Code + Codex CLI 0.142.5), so
 * the file must stay inside the intersection both parsers accept:
 *   - `hooks` is the ONLY top-level key (codex 0.142.5 deny-unknown-fields:
 *     any other key silently disables the whole file — GT §2.2.2 / C17)
 *   - matchers are exact-alternations from a known tool-name vocabulary, or
 *     valid regexes (invalid regex ⇒ handler dropped at discovery — GT §2.4.1)
 *   - `apply_patch` never appears in a matcher (Write/Edit alias-fire for
 *     apply_patch on codex; adding it only churns trust hashes — GT §2.4.2)
 *   - no `async: true` handlers (skipped by codex with a warning — GT §2.2.4)
 *   - `timeout` is numeric SECONDS (codex default 600, min 1 — GT §2.2.1)
 *
 * Usage:
 *   node scripts/lint-hooks-json.js [files...]   # default: plugins/*\/hooks/hooks.json
 *
 * Exit codes: 0 clean, 1 violations, 2 config error.
 */

const fs = require('node:fs');
const path = require('node:path');

const EXIT_OK = 0;
const EXIT_VIOLATIONS = 1;
const EXIT_CONFIG_ERROR = 2;

const REPO_ROOT = path.join(__dirname, '..');

// Claude Code events ∪ codex 0.142.5 events (GT §2.3.1; unknown event names
// are tolerated by codex — §2.2.3 — but a typo'd event silently never fires).
const KNOWN_EVENTS = new Set([
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'Notification',
]);

// Events whose matcher input is a tool name (GT §2.4.2).
const TOOL_MATCHER_EVENTS = new Set(['PreToolUse', 'PostToolUse', 'PermissionRequest']);

// Known tool-name vocabulary for exact-alternation matchers: Claude built-in
// tools + codex flat names (GT §2.5.3, probe P3). `apply_patch` is
// deliberately absent — see header.
const TOOL_NAME_VOCAB = new Set([
  'Task',
  'Skill',
  'Agent',
  'Bash',
  'BashOutput',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Grep',
  'Glob',
  'WebFetch',
  'WebSearch',
  'TodoWrite',
  'AskUserQuestion',
  'ExitPlanMode',
  'KillShell',
  'SlashCommand',
  'Monitor',
  'request_user_input',
  'spawn_agent',
  'update_plan',
  'view_image',
  'read_mcp_resource',
  'web_search',
]);

// Non-tool events with a closed matcher-value vocabulary (GT §2.4.2).
const EVENT_VALUE_VOCAB = {
  SessionStart: new Set(['startup', 'resume', 'clear', 'compact']),
  PreCompact: new Set(['manual', 'auto']),
  PostCompact: new Set(['manual', 'auto']),
};

const GROUP_KEYS = new Set(['matcher', 'hooks']);
const HANDLER_KEYS = new Set([
  'type',
  'command',
  'timeout',
  'commandWindows',
  'async',
  'statusMessage',
]);

// Only [A-Za-z0-9_|] ⇒ EXACT match with alternatives; anything else ⇒ regex
// (unanchored Rust `is_match` — GT §2.4.1).
const EXACT_MATCHER_RE = /^[A-Za-z0-9_|]+$/;
const MCP_TOOL_RE = /^mcp__[A-Za-z0-9_]+$/;
// Constructs JS accepts but Rust's regex crate rejects (would drop the
// handler at codex discovery time): lookaround and backreferences.
const RUST_REGEX_UNSUPPORTED_RE = /\(\?=|\(\?!|\(\?<=|\(\?<!|\\[1-9]/;

const MAX_TIMEOUT_SECONDS = 3600;

function lintExactTokens(event, matcher, where, violations) {
  for (const token of matcher.split('|')) {
    if (token === '') {
      violations.push(`${where}: empty alternative in exact matcher "${matcher}"`);
    } else if (TOOL_MATCHER_EVENTS.has(event)) {
      if (!TOOL_NAME_VOCAB.has(token) && !MCP_TOOL_RE.test(token)) {
        violations.push(`${where}: unknown tool name "${token}" in matcher "${matcher}"`);
      }
    } else if (EVENT_VALUE_VOCAB[event] && !EVENT_VALUE_VOCAB[event].has(token)) {
      violations.push(`${where}: unknown ${event} matcher value "${token}"`);
    }
  }
}

function lintRegexMatcher(matcher, where, violations) {
  try {
    new RegExp(matcher);
  } catch (err) {
    violations.push(`${where}: invalid regex matcher "${matcher}" (${err.message})`);
    return;
  }
  if (RUST_REGEX_UNSUPPORTED_RE.test(matcher)) {
    violations.push(
      `${where}: matcher "${matcher}" uses lookaround/backreference — not valid Rust regex, codex drops the handler`
    );
  }
}

function lintMatcher(event, matcher, where, violations) {
  if (matcher === undefined) return;
  if (typeof matcher !== 'string') {
    violations.push(`${where}: matcher must be a string`);
    return;
  }
  if (matcher.includes('apply_patch')) {
    violations.push(
      `${where}: matcher "${matcher}" contains "apply_patch" — use Write/Edit (codex alias-fires them for apply_patch)`
    );
  }
  if (matcher === '' || matcher === '*') return;
  if (EXACT_MATCHER_RE.test(matcher)) {
    lintExactTokens(event, matcher, where, violations);
  } else {
    lintRegexMatcher(matcher, where, violations);
  }
}

function lintHandler(handler, where, violations) {
  if (handler === null || typeof handler !== 'object' || Array.isArray(handler)) {
    violations.push(`${where}: handler must be an object`);
    return;
  }
  for (const key of Object.keys(handler)) {
    if (!HANDLER_KEYS.has(key)) violations.push(`${where}: unknown handler key "${key}"`);
  }
  if (handler.type !== 'command') {
    violations.push(
      `${where}: handler type must be "command" (got ${JSON.stringify(handler.type)})`
    );
  }
  if (typeof handler.command !== 'string' || handler.command.trim() === '') {
    violations.push(`${where}: handler command must be a non-empty string`);
  }
  if (handler.async === true) {
    violations.push(`${where}: async:true handlers are skipped by codex — remove it`);
  }
  lintTimeout(handler.timeout, where, violations);
}

function lintTimeout(timeout, where, violations) {
  if (timeout === undefined) return;
  if (!Number.isInteger(timeout) || timeout < 1) {
    violations.push(`${where}: timeout must be an integer number of seconds >= 1`);
  } else if (timeout > MAX_TIMEOUT_SECONDS) {
    violations.push(
      `${where}: timeout ${timeout} exceeds ${MAX_TIMEOUT_SECONDS}s — looks like milliseconds (timeout is SECONDS)`
    );
  }
}

function lintGroup(event, group, where, violations) {
  if (group === null || typeof group !== 'object' || Array.isArray(group)) {
    violations.push(`${where}: matcher group must be an object`);
    return;
  }
  for (const key of Object.keys(group)) {
    if (!GROUP_KEYS.has(key)) violations.push(`${where}: unknown matcher-group key "${key}"`);
  }
  lintMatcher(event, group.matcher, where, violations);
  if (!Array.isArray(group.hooks) || group.hooks.length === 0) {
    violations.push(`${where}: "hooks" must be a non-empty array of handlers`);
    return;
  }
  group.hooks.forEach((handler, i) => lintHandler(handler, `${where}.hooks[${i}]`, violations));
}

function lintDocument(doc, violations) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    violations.push('top level must be a JSON object');
    return;
  }
  const extraKeys = Object.keys(doc).filter((k) => k !== 'hooks');
  if (extraKeys.length > 0) {
    violations.push(
      `top-level keys other than "hooks" disable the whole file on codex 0.142.5: ${extraKeys.join(', ')}`
    );
  }
  if (doc.hooks === null || typeof doc.hooks !== 'object' || Array.isArray(doc.hooks)) {
    violations.push('"hooks" must be an object keyed by event name');
    return;
  }
  lintEvents(doc.hooks, violations);
}

function lintEvents(hooks, violations) {
  for (const [event, groups] of Object.entries(hooks)) {
    if (!KNOWN_EVENTS.has(event)) {
      violations.push(`hooks.${event}: unknown event name`);
      continue;
    }
    if (!Array.isArray(groups)) {
      violations.push(`hooks.${event}: must be an array of matcher groups`);
      continue;
    }
    groups.forEach((group, i) => lintGroup(event, group, `hooks.${event}[${i}]`, violations));
  }
}

function lintFile(file) {
  const violations = [];
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return [`unreadable: ${err.message}`];
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return [`invalid JSON: ${err.message}`];
  }
  lintDocument(doc, violations);
  return violations;
}

function defaultFiles() {
  const pluginsDir = path.join(REPO_ROOT, 'plugins');
  return fs
    .readdirSync(pluginsDir)
    .map((name) => path.join(pluginsDir, name, 'hooks', 'hooks.json'))
    .filter((file) => fs.existsSync(file))
    .sort();
}

function main() {
  const args = process.argv.slice(2);
  const files = args.length > 0 ? args : defaultFiles();
  if (files.length === 0) {
    console.error('lint-hooks-json: no hooks.json files found');
    process.exit(EXIT_CONFIG_ERROR);
  }
  let total = 0;
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file) || file;
    const violations = lintFile(file);
    total += violations.length;
    for (const v of violations) console.error(`${rel}: ${v}`);
    if (violations.length === 0) console.log(`OK ${rel}`);
  }
  if (total > 0) {
    console.error(`lint-hooks-json: ${total} violation(s) across ${files.length} file(s)`);
    process.exit(EXIT_VIOLATIONS);
  }
  process.exit(EXIT_OK);
}

if (require.main === module) main();

module.exports = { lintFile, defaultFiles };
