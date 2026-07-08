'use strict';

/**
 * tools.js — canonical tool taxonomy shared by every ported hook.
 *
 * Maps the two runtimes' native tool names onto one kind vocabulary
 * ('shell'|'write'|'agent'|'skill'|'question'|'plan'|'mcp'|'read'|'other'),
 * extracts write targets uniformly (claude `file_path` fields vs the codex
 * apply_patch raw-patch payload), and evaluates synapsys-style `Tool:pattern`
 * specs with the Edit/Write→apply_patch alias hop.
 *
 * Ground truth: docs/codex-support/01-codex-ground-truth.md §2.5.3–2.5.5
 * (tool_name vocabulary, apply_patch tool_input shape) and the live probe
 * captures checked in under tests/fixtures/runtime/codex/.
 */

const CLAUDE_WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const KIND_BY_NAME = {
  Bash: 'shell',
  Edit: 'write',
  Write: 'write',
  MultiEdit: 'write',
  NotebookEdit: 'write',
  apply_patch: 'write',
  Task: 'agent',
  Agent: 'agent',
  spawn_agent: 'agent',
  Skill: 'skill',
  AskUserQuestion: 'question',
  request_user_input: 'question',
  TodoWrite: 'plan',
  update_plan: 'plan',
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  view_image: 'read',
  read_mcp_resource: 'read',
  read_file: 'read',
};

/**
 * Canonical kind for a native tool name. The mapping is name-keyed (the two
 * runtimes' vocabularies do not collide); `runtime` is part of the signature
 * so call sites stay explicit about which dialect produced the name.
 */
function canonicalToolKind(rawToolName, _runtime) {
  if (!rawToolName || typeof rawToolName !== 'string') return null;
  if (rawToolName.startsWith('mcp__')) return 'mcp';
  return KIND_BY_NAME[rawToolName] || 'other';
}

const FILE_HEADER_RE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const MOVE_RE = /^\*\*\* Move to: (.+)$/;
const OP_BY_HEADER = { Add: 'create', Update: 'modify', Delete: 'delete' };

function unparseableTarget() {
  return [{ path: null, op: null, ok: false }];
}

/**
 * Parse codex apply_patch text (`*** Begin Patch … *** End Patch`) into write
 * targets. A `*** Move to:` header emits BOTH the source and the destination
 * as op:'move' targets so protectors check every touched path. Missing
 * sentinel or zero file headers ⇒ a single `ok:false` target — the fail-closed
 * signal for heimdall (C6).
 */
function parseApplyPatch(patchText) {
  if (typeof patchText !== 'string' || !patchText.includes('*** Begin Patch')) {
    return unparseableTarget();
  }
  const targets = [];
  for (const line of patchText.split('\n')) {
    const header = line.match(FILE_HEADER_RE);
    if (header) {
      targets.push({ path: header[2].trim(), op: OP_BY_HEADER[header[1]], ok: true });
      continue;
    }
    const move = line.match(MOVE_RE);
    if (move && targets.length > 0) {
      targets[targets.length - 1].op = 'move';
      targets.push({ path: move[1].trim(), op: 'move', ok: true });
    }
  }
  return targets.length > 0 ? targets : unparseableTarget();
}

const CLAUDE_TARGET_FIELD = { NotebookEdit: 'notebook_path' };

/**
 * Uniform write-target extraction. Non-write tools ⇒ []. Claude write tools
 * read their path field; codex apply_patch parses the patch headers. Paths are
 * returned as written — callers resolve relative paths against evt.cwd.
 */
function extractWriteTargets(rawToolName, toolInput, runtime) {
  if (canonicalToolKind(rawToolName, runtime) !== 'write') return [];
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  if (rawToolName === 'apply_patch') return parseApplyPatch(input.command);
  const field = CLAUDE_TARGET_FIELD[rawToolName] || 'file_path';
  const target = typeof input[field] === 'string' && input[field] ? input[field] : null;
  const op = rawToolName === 'Write' ? 'create' : 'modify';
  return [{ path: target, op, ok: target !== null }];
}

function addedPatchLines(patchText) {
  if (typeof patchText !== 'string') return [];
  return patchText
    .split('\n')
    .filter((line) => line.startsWith('+'))
    .map((line) => line.slice(1));
}

const CONTENT_EXTRACTORS = {
  Edit: (input) => (typeof input.new_string === 'string' ? [input.new_string] : []),
  Write: (input) => (typeof input.content === 'string' ? [input.content] : []),
  MultiEdit: (input) =>
    Array.isArray(input.edits)
      ? input.edits.map((e) => e && e.new_string).filter((s) => typeof s === 'string')
      : [],
  NotebookEdit: (input) => (typeof input.new_source === 'string' ? [input.new_source] : []),
  apply_patch: (input) => addedPatchLines(input.command),
};

/**
 * Written content per tool: new_string/content fields on claude, the
 * '+'-prefixed patch lines on codex apply_patch. Always a string array.
 */
function extractWriteContent(rawToolName, toolInput) {
  const extractor = CONTENT_EXTRACTORS[rawToolName];
  if (!extractor || !toolInput || typeof toolInput !== 'object') return [];
  return extractor(toolInput);
}

function safeRegex(pattern) {
  try {
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

function parseToolSpec(spec) {
  const raw = typeof spec === 'string' ? spec : '';
  const colon = raw.indexOf(':');
  if (colon === -1) return { tool: raw.trim(), pat: '' };
  return { tool: raw.slice(0, colon).trim(), pat: raw.slice(colon + 1).trim() };
}

/**
 * Evaluate a synapsys-style `Tool:pattern` spec against a CanonicalHookEvent.
 * Native semantics match synapsys pretoolSpecMatches (exact tool or '*', regex
 * over the JSON-stringified tool_input). The alias hop: Edit/Write/MultiEdit/
 * NotebookEdit specs also match `apply_patch` events when a parsed write
 * target path matches the pattern — user memories keep firing on codex with
 * zero data migration (design §C / WP-05).
 */
function anyWriteTargetMatches(evt, re) {
  const targets = (evt && evt.writeTargets) || [];
  return targets.some((t) => t.ok && typeof t.path === 'string' && re.test(t.path));
}

/** Native tool-name leg: exact tool, '*', or an empty (tool-less) spec. */
function toolNameApplies(tool, rawToolName) {
  return !tool || tool === '*' || tool === rawToolName;
}

function inputPatternMatches(evt, re) {
  if (!re) return true;
  return re.test(JSON.stringify((evt && evt.toolInput) || {}));
}

function aliasesToApplyPatch(tool, rawToolName) {
  return rawToolName === 'apply_patch' && CLAUDE_WRITE_TOOLS.has(tool);
}

function matchesToolSpec(spec, evt) {
  const { tool, pat } = parseToolSpec(spec);
  const re = pat ? safeRegex(pat) : null;
  if (pat && !re) return false;
  const rawToolName = (evt && evt.rawToolName) || '';
  if (toolNameApplies(tool, rawToolName)) return inputPatternMatches(evt, re);
  if (aliasesToApplyPatch(tool, rawToolName)) return !re || anyWriteTargetMatches(evt, re);
  return false;
}

module.exports = {
  CLAUDE_WRITE_TOOLS,
  canonicalToolKind,
  parseApplyPatch,
  extractWriteTargets,
  extractWriteContent,
  matchesToolSpec,
  parseToolSpec,
  safeRegex,
};
