#!/usr/bin/env node
'use strict';

/**
 * Synapsys dispatcher hook.
 *
 * Usage (registered in hooks.json):
 *   node synapsys.js <Event>
 *
 * Stdin: Claude Code hook JSON payload.
 * Stdout: Injected text (becomes a <system-reminder> in the conversation)
 *         when one or more memories match the event + trigger pattern.
 *
 * Fail-open: any error → exit 0 with no output. Memory injection must
 * never block the user's prompt or tool call.
 */

const path = require('node:path');
const { discoverStores, listMemoriesFromStore } = require(
  path.join(__dirname, '..', 'lib', 'memory-store')
);
const { selectForEvent } = require(path.join(__dirname, '..', 'lib', 'matcher'));
const { loadDomainRegistry } = require(path.join(__dirname, '..', 'lib', 'domains'));
const { classifyActiveDomains, classifyWithSticky } = require(
  path.join(__dirname, '..', 'lib', 'classifier')
);
const { loadStickyState, saveStickyState } = require(
  path.join(__dirname, '..', 'lib', 'sticky-state')
);

const VALID_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']);
const MAX_INJECT_CHARS = 8000;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

function parsePayload(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function formatMemory(m) {
  const header = `[synapsys:${m.store.kind}] ${m.name} — ${m.description || '(no description)'}`;
  if (m.inject === 'full') {
    return `${header}\n\n${m.body.trim()}`;
  }
  return `${header}\n  source: ${m.file}`;
}

const SETUP_REQUIRED_HINT =
  '[synapsys:setup-required] No Synapsys memory store is configured for this repo/worktree.\n\n' +
  'AGENT: As your FIRST action this session, surface this to the user and offer to run `/synapsys:install`. Recommend the kind based on context:\n' +
  '  - If `git worktree list` shows >1 entry → recommend `worktree` (shared across all worktrees of this repo)\n' +
  '  - Otherwise → recommend `local`\n' +
  '  - Mention `global` (per-project, survives worktree deletion) and `shared` (one store reused across ALL projects) as options\n\n' +
  'Do NOT install without asking — present the recommendation via `AskUserQuestion` so the user can confirm or choose differently. If the user declines, set SYNAPSYS_NO_SETUP_HINT=1 to silence this prompt for future sessions.';

function emptyStoreHint(stores) {
  const dirs = stores.map((s) => `${s.kind} (${s.dir})`).join(', ');
  return (
    `[synapsys:empty-store] Memory store(s) ready: ${dirs}. No memories yet.\n\n` +
    'AGENT: Mention this to the user and offer two paths:\n' +
    "  - `/synapsys:crystallize` — import Claude's existing auto-memories (if any exist for this repo)\n" +
    '  - `/synapsys:memorize "<what to remember>"` — add a memory manually\n\n' +
    'Do not auto-run either — let the user pick. If they decline, set SYNAPSYS_NO_SETUP_HINT=1 to silence.'
  );
}

// Returns a hint string when SessionStart fires with no store or no memories.
// Returns null when no hint should be emitted (hint disabled or store + memories present).
function getSessionStartHint(event, stores, memories) {
  if (event !== 'SessionStart') return null;
  if (process.env.SYNAPSYS_NO_SETUP_HINT === '1') return null;
  if (!stores.length) return SETUP_REQUIRED_HINT;
  if (!memories.length) return emptyStoreHint(stores);
  return null;
}

// Serialize the PreToolUse invoking tool (`tool_name` + `tool_input`) into a
// single string so `signal_pretool` regexes match against the tool under
// execution, not just historical calls. Returns null when the event is not
// PreToolUse or no tool fields are present.
function currentToolCallString(event, payload) {
  if (event !== 'PreToolUse') return null;
  const toolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  if (!toolName) return null;
  let inputStr = '';
  const input = payload.tool_input;
  if (input != null) {
    try {
      inputStr = typeof input === 'string' ? input : JSON.stringify(input);
    } catch {
      inputStr = '';
    }
  }
  return `${toolName} ${inputStr}`.trim();
}

// Merge sticky-active domains for a session into a raw-active set without
// mutating streaks. Used for non-prompt events where AC5/AC6 hysteresis
// (which counts "prompts", not arbitrary hook turns) must not advance.
function mergeStickyActive(rawActive, stickyState, sessionId) {
  const merged = new Set(rawActive);
  const session = (stickyState && stickyState[sessionId]) || {};
  for (const domain of Object.keys(session)) {
    const entry = session[domain];
    if (entry && entry.sticky === true) merged.add(domain);
  }
  return merged;
}

// Classify the payload's prompt + recentToolCalls into a set of active
// domain tags and return an opts object suitable for `selectForEvent`.
// Only `UserPromptSubmit` advances sticky-state streaks (AC5/AC6 describe
// quiet *prompts*, not Stop/PreToolUse turns). Other events read the
// existing sticky set without mutation. Fail-open: any error → returns
// `undefined` so the caller falls back to pre-classifier behavior (R3/R4/R7).
function getRecentToolCalls(event, payload) {
  const baseToolCalls = Array.isArray(payload.recentToolCalls)
    ? payload.recentToolCalls
    : Array.isArray(payload.recent_tool_calls)
      ? payload.recent_tool_calls
      : [];
  const currentTool = currentToolCallString(event, payload);
  return currentTool ? [currentTool, ...baseToolCalls] : baseToolCalls;
}

function classifyForUserPrompt(ctx) {
  const { activeDomains, nextStickyState } = classifyWithSticky(ctx);
  try {
    saveStickyState({ state: nextStickyState });
  } catch {
    // fail-open: persistence failures must not block injection
  }
  return { activeDomains };
}

function buildActiveDomainsForPayload(event, payload) {
  try {
    const registry = loadDomainRegistry();
    if (!registry || !registry.roots || registry.roots.size === 0) return undefined;

    const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
    const recentToolCalls = getRecentToolCalls(event, payload);
    const sessionId = payload.session_id || payload.sessionId || 'default';
    const stickyState = loadStickyState();

    if (event === 'UserPromptSubmit') {
      return classifyForUserPrompt({
        prompt,
        recentToolCalls,
        registry,
        stickyState,
        sessionId,
      });
    }

    const rawActive = classifyActiveDomains({ prompt, recentToolCalls, registry });
    return { activeDomains: mergeStickyActive(rawActive, stickyState, sessionId) };
  } catch {
    return undefined;
  }
}

function formatMatchedOutput(matched) {
  const out = matched.map(formatMemory).join('\n\n---\n\n');
  if (out.length <= MAX_INJECT_CHARS) return out;
  return `${out.slice(0, MAX_INJECT_CHARS)}\n\n[synapsys: output truncated at ${MAX_INJECT_CHARS} chars]`;
}

(async () => {
  try {
    const event = process.argv[2];
    if (!VALID_EVENTS.has(event)) process.exit(0);

    const payload = parsePayload(await readStdin());
    const cwd = payload.cwd || process.cwd();
    const stores = discoverStores(cwd);
    const memories = stores.flatMap(listMemoriesFromStore);

    const sessionHint = getSessionStartHint(event, stores, memories);
    if (sessionHint) {
      process.stdout.write(sessionHint);
      process.exit(0);
    }

    if (!memories.length) process.exit(0);

    // Build activeDomains from registry + sticky-state (fail-open: on any
    // error, omit `opts.activeDomains` to preserve pre-classifier behavior).
    const selectOpts = buildActiveDomainsForPayload(event, payload);
    const matched = selectForEvent(memories, event, payload, selectOpts);
    if (!matched.length) process.exit(0);

    process.stdout.write(formatMatchedOutput(matched));
    process.exit(0);
  } catch {
    process.exit(0);
  }
})();
