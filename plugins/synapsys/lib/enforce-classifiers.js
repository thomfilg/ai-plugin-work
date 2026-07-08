'use strict';

/**
 * enforce-classifiers — named built-in classifier registry for per-memory
 * `enforce: block` gating (GH-520). Pure regex + tiny JSON session state; NO
 * model calls. A classifier answers "should this specific tool call block?"
 * AFTER the memory's trigger_pretool ladder already matched.
 *
 * Registry:
 *   - symbol-shape          — grep-style symbol lookups whose pattern is a
 *                             bare identifier (the codegraph case).
 *   - first-edit-of-session — the first Edit/Write/MultiEdit/NotebookEdit of a
 *                             session, unless a satisfier tool (the memory's
 *                             `enforce_satisfied_by` regex) was observed first.
 *
 * Contract: classifiers return 'block' or 'allow'. Conservative: ANY ambiguity
 * (unparseable input, missing pattern, throw) → 'allow'. Unknown classifier
 * names are the caller's problem (hooks/lib/enforce.js treats the memory as
 * advise and warns on stderr).
 *
 * Session state lives beside the inject-ledger files
 * (`<sessionDir>/<sessionId>.enforce-state.json`, SYNAPSYS_SESSION_DIR
 * override honored) and is updated on EVERY PreToolUse dispatch via
 * `observePreTool` — call it AFTER classification so the call under judgment
 * never satisfies its own gate. Fail-open throughout.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sessionIdLib = require('./session-id');

// apply_patch is the codex file-edit tool (ground truth §2.5.3); Claude never
// sends it, so the claude path is unchanged.
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'apply_patch']);
const TOOLS_CAP = 200;

// ---------------------------------------------------------------------------
// symbol-shape
// ---------------------------------------------------------------------------

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
// `$` is identifier-legal but also a regex anchor — conservative: allow.
const STOPLIST = new Set(['TODO', 'FIXME', 'README', 'NOTE', 'XXX']);
// Target paths where identifier greps are legitimate documentation/vendor
// lookups — never block those.
const ALLOW_PATH_RE = /(\.md\b|\.claude\/|node_modules)/;

// Tokenize a shell fragment into words, honoring simple single/double quotes.
function tokenizeShell(fragment) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(fragment)) !== null) {
    tokens.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
  }
  return tokens;
}

// Extract { pattern, args } from a Bash command containing a grep/rg
// invocation: the first quoted/bare non-flag token after the program name is
// the pattern; every other token participates in the allow-path check.
function extractFromBash(command) {
  const m = command.match(/(?:^|[\s|;&(])(?:grep|rg)\s+([\s\S]*)$/);
  if (!m) return null;
  const tokens = tokenizeShell(m[1]);
  let pattern = null;
  const args = [];
  for (const tok of tokens) {
    if (pattern === null && tok.startsWith('-')) {
      args.push(tok);
      continue;
    }
    if (pattern === null) {
      pattern = tok;
      continue;
    }
    args.push(tok);
  }
  if (pattern === null) return null;
  return { pattern, args };
}

// Extract the search pattern + target args from the tool call. Grep tool →
// tool_input.pattern; Bash → first non-flag arg after grep/rg; anything else
// → null (= allow).
function extractSearchTarget(payload) {
  const toolName = (payload && payload.tool_name) || '';
  const input = (payload && payload.tool_input) || {};
  if (toolName === 'Grep') {
    if (typeof input.pattern !== 'string') return null;
    const args = [input.path, input.glob].filter((v) => typeof v === 'string');
    return { pattern: input.pattern, args };
  }
  if (toolName === 'Bash' && typeof input.command === 'string') {
    return extractFromBash(input.command);
  }
  return null;
}

// 'block' only when the pattern is unambiguously identifier-shaped (a symbol
// lookup better served by the code graph). Everything else → 'allow'.
function symbolShape(_memory, payload) {
  const target = extractSearchTarget(payload);
  if (!target || typeof target.pattern !== 'string') return 'allow';
  const p = target.pattern;
  if (p.length < 3 || p.length > 50) return 'allow';
  if (!IDENT_RE.test(p)) return 'allow';
  if (p.includes('$')) return 'allow';
  if (STOPLIST.has(p.toUpperCase())) return 'allow';
  if (target.args.some((a) => typeof a === 'string' && ALLOW_PATH_RE.test(a))) return 'allow';
  return 'block';
}

// ---------------------------------------------------------------------------
// first-edit-of-session — session state
// ---------------------------------------------------------------------------

function stateDir() {
  if (process.env.SYNAPSYS_SESSION_DIR) return process.env.SYNAPSYS_SESSION_DIR;
  return path.join(os.homedir(), '.claude', 'synapsys', '.session');
}

function safeStateId(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return '_unknown-session';
  return sessionIdLib.SAFE_ID_RE.test(sessionId) ? sessionId : sessionIdLib.hashId(sessionId);
}

function stateFile(sessionId) {
  return path.join(stateDir(), `${safeStateId(sessionId)}.enforce-state.json`);
}

function emptyState() {
  return { tools: [], firstEditSeen: false };
}

function loadState(sessionId) {
  try {
    const raw = fs.readFileSync(stateFile(sessionId), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      tools: Array.isArray(parsed.tools) ? parsed.tools.filter((t) => typeof t === 'string') : [],
      firstEditSeen: parsed.firstEditSeen === true,
    };
  } catch {
    return emptyState();
  }
}

function saveState(sessionId, state) {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(stateFile(sessionId), JSON.stringify(state));
  } catch {
    /* fail-open */
  }
}

// Observe EVERY PreToolUse dispatch (cheap, fail-open): record the tool name
// as a potential satisfier and mark the first-edit gate consumed once the
// first edit-family tool passes through (allowed OR blocked — it's a
// first-edit gate, not a permanent one). Call AFTER classification.
function observePreTool(sessionId, payload) {
  try {
    const toolName = payload && payload.tool_name;
    if (typeof toolName !== 'string' || toolName.length === 0) return;
    const state = loadState(sessionId);
    let dirty = false;
    if (!state.tools.includes(toolName)) {
      state.tools.push(toolName);
      if (state.tools.length > TOOLS_CAP) state.tools.shift();
      dirty = true;
    }
    if (EDIT_TOOLS.has(toolName) && !state.firstEditSeen) {
      state.firstEditSeen = true;
      dirty = true;
    }
    if (dirty) saveState(sessionId, state);
  } catch {
    /* fail-open */
  }
}

// Resolve the memory's `enforce_satisfied_by` regex source (top-level field
// first, raw frontmatter as fallback). Empty string when unset.
function _satisfierSource(memory) {
  return (
    (memory && memory.enforceSatisfiedBy) ||
    (memory && memory.meta && memory.meta.enforce_satisfied_by) ||
    ''
  );
}

// True when a previously observed tool name matches the satisfier regex.
// An unparseable satisfier regex counts as satisfied → conservative allow.
function _satisfierMatched(satisfiedBy, state) {
  let re;
  try {
    re = new RegExp(String(satisfiedBy));
  } catch {
    return true; // unparseable satisfier regex → conservative allow
  }
  return state.tools.some((t) => re.test(t));
}

// 'block' for the first edit-family call of the session UNLESS a previously
// observed tool name matches the memory's `enforce_satisfied_by` regex.
function firstEditOfSession(memory, payload, ctx) {
  const toolName = (payload && payload.tool_name) || '';
  if (!EDIT_TOOLS.has(toolName)) return 'allow';
  const state = loadState(ctx && ctx.sessionId);
  if (state.firstEditSeen) return 'allow';
  const satisfiedBy = _satisfierSource(memory);
  if (satisfiedBy && _satisfierMatched(satisfiedBy, state)) return 'allow';
  return 'block';
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const CLASSIFIERS = {
  'symbol-shape': symbolShape,
  'first-edit-of-session': firstEditOfSession,
};

const CLASSIFIER_NAMES = Object.keys(CLASSIFIERS);

function getClassifier(name) {
  return Object.prototype.hasOwnProperty.call(CLASSIFIERS, name) ? CLASSIFIERS[name] : null;
}

module.exports = {
  CLASSIFIER_NAMES,
  getClassifier,
  observePreTool,
  // Exposed for unit tests.
  symbolShape,
  firstEditOfSession,
  extractSearchTarget,
};
