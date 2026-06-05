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
const injectLedger = require('../lib/inject-ledger');
const { recordFired } = require(path.join(__dirname, '..', 'lib', 'telemetry'));
const { runCiteScan } = require(path.join(__dirname, '..', 'lib', 'cite-scan'));

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * decideInjection — pure helper implementing the brief AC-5 renderer policy.
 *
 *   always       → full body on every match
 *   once         → full body iff injectedCount === 0, else reminder
 *   occasionally → full body iff injectedCount % fireCadence === 0, else reminder
 *
 * `ledgerEntry` is the per-memory record from `loadLedger().memories[name]`
 * (or `undefined` for "never injected this session").
 */
function resolveCadence(memory) {
  const raw = Number(memory && memory.fireCadence);
  return raw > 0 ? raw : 5;
}

function decideInjection(memory, ledgerEntry) {
  const mode = (memory && memory.fireMode) || 'once';
  const count = Number(ledgerEntry && ledgerEntry.injectedCount) || 0;
  if (mode === 'always') return { kind: 'full' };
  if (mode === 'occasionally') {
    const cadence = resolveCadence(memory);
    return { kind: count % cadence === 0 ? 'full' : 'reminder' };
  }
  // default: once
  return { kind: count === 0 ? 'full' : 'reminder' };
}

function reminderLine(memory) {
  return `[synapsys:active] ${memory.name} (fired earlier; full body in this session)`;
}

/**
 * renderMatchedMemories — per-memory loop wrapper. Routes each match through
 * the ledger + decideInjection + recordInjection. The entire call is fail-open
 * (R1): any throw → fall back to formatting every memory as full body.
 */
const SEP = '\n\n---\n\n';

function commitInjection(ledger, sessionId, memory, isFull) {
  const entry = ledger.memories[memory.name];
  const prevCount = Number(entry && entry.injectedCount) || 0;
  const prevLast = Number(entry && entry.lastFullInjectAt) || 0;
  const nextCount = prevCount + 1;
  ledger.memories[memory.name] = {
    injectedCount: nextCount,
    lastFullInjectAt: isFull ? nextCount : prevLast,
  };
  try {
    injectLedger.recordInjection(sessionId, memory.name, { full: isFull });
  } catch {
    /* fail-open */
  }
}

// Cap-aware renderer. Only memories whose rendered text fits within
// MAX_INJECT_CHARS are recorded in the ledger — anything truncated by the cap
// keeps its prior injectedCount so it can re-fire (full body) on a later match.
function renderMatchedMemories(matched, sessionId) {
  try {
    const ledger = injectLedger.loadLedger(sessionId);
    if (!ledger.memories || typeof ledger.memories !== 'object') {
      ledger.memories = {};
    }
    const pieces = [];
    let used = 0;
    let truncated = false;
    for (const m of matched) {
      const decision = decideInjection(m, ledger.memories[m.name]);
      const isFull = decision.kind === 'full';
      const text = isFull ? formatMemory(m) : reminderLine(m);
      const sepLen = pieces.length ? SEP.length : 0;
      if (used + sepLen + text.length > MAX_INJECT_CHARS) {
        truncated = true;
        break;
      }
      pieces.push(text);
      used += sepLen + text.length;
      commitInjection(ledger, sessionId, m, isFull);
    }
    const body = pieces.join(SEP);
    return truncated
      ? `${body}${SEP}[synapsys: output truncated at ${MAX_INJECT_CHARS} chars]`
      : body;
  } catch {
    return matched.map(formatMemory).join(SEP);
  }
}

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

// SessionStart has no prompt/tool signal yet; Stop/PreToolUse can produce an
// empty merged set. In either case, returning an empty `activeDomains` would
// hard-gate every domain-tagged memory. Fail-open with `undefined` so unrelated
// triggers (trigger_session, trigger_pretool) still fire.
function passiveActiveDomains(event, payload, registry, stickyState, sessionId) {
  if (event === 'SessionStart') return undefined;
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  const recentToolCalls = getRecentToolCalls(event, payload);
  const rawActive = classifyActiveDomains({ prompt, recentToolCalls, registry });
  const activeDomains = mergeStickyActive(rawActive, stickyState, sessionId);
  if (!activeDomains || activeDomains.size === 0) return undefined;
  return { activeDomains };
}

function buildActiveDomainsForPayload(event, payload) {
  try {
    const registry = loadDomainRegistry();
    if (!registry || !registry.roots || registry.roots.size === 0) return undefined;

    const sessionId = payload.session_id || payload.sessionId || 'default';
    const stickyState = loadStickyState();

    if (event === 'UserPromptSubmit') {
      return classifyForUserPrompt({
        prompt: typeof payload.prompt === 'string' ? payload.prompt : '',
        recentToolCalls: getRecentToolCalls(event, payload),
        registry,
        stickyState,
        sessionId,
      });
    }

    return passiveActiveDomains(event, payload, registry, stickyState, sessionId);
  } catch {
    return undefined;
  }
}

function formatMatchedOutput(matched, sessionId) {
  const out = renderMatchedMemories(matched, sessionId);
  if (out.length <= MAX_INJECT_CHARS) return out;
  return `${out.slice(0, MAX_INJECT_CHARS)}\n\n[synapsys: output truncated at ${MAX_INJECT_CHARS} chars]`;
}

function emitMatched(matched, payload, event) {
  if (!matched.length) return;
  for (const m of matched) {
    try {
      recordFired(m, payload, event);
    } catch {
      // fail-open
    }
  }
}

(async () => {
  try {
    const event = process.argv[2];
    if (!VALID_EVENTS.has(event)) process.exit(0);

    const payload = parsePayload(await readStdin());
    const cwd = payload.cwd || process.cwd();
    const stores = discoverStores(cwd);
    const memories = stores.flatMap(listMemoriesFromStore);

    // Resolve session id once; used for both ledger reset (SessionStart) and
    // the per-memory render path. Fail-open: any throw → noop and the rest of
    // the dispatcher behaves like the pre-ledger code path.
    let sessionId;
    try {
      sessionId = injectLedger.resolveSessionId(payload);
      // Publish the resolved id to `.current` so out-of-process callers
      // (synapsys-list CLI) read the same session ledger the dispatcher
      // writes to. Fail-open: a write error never blocks the dispatcher.
      injectLedger.publishCurrentSessionId(sessionId);
    } catch {
      sessionId = '';
    }

    // SessionStart resets the per-session ledger (brief AC-4 / spec §3.3) and
    // opportunistically GCs stale ledger files older than 7 days (spec §4.2).
    if (event === 'SessionStart') {
      try {
        injectLedger.resetLedgerForSession(sessionId);
        injectLedger.gcStaleLedgers({ maxAgeMs: SEVEN_DAYS_MS });
      } catch {
        /* fail-open */
      }
    }

    const sessionHint = getSessionStartHint(event, stores, memories);
    if (sessionHint) {
      process.stdout.write(sessionHint);
      process.exit(0);
    }

    // Build activeDomains FIRST so UserPromptSubmit advances sticky-state
    // even when the memory list is empty. Fail-open: on any error, omit
    // `opts.activeDomains` to preserve pre-classifier behavior.
    const selectOpts = buildActiveDomainsForPayload(event, payload);
    const matched = memories.length ? selectForEvent(memories, event, payload, selectOpts) : [];
    // On Stop the cite scan must read the session JSONL state from BEFORE
    // this turn's Stop-time fired writes; Stop-injections happen after the
    // assistant response, so attributing citations to them would be a
    // false positive (the response cannot reference a memory that wasn't
    // yet injected at the time it was written).
    if (event === 'Stop') runCiteScan(payload, memories);
    emitMatched(matched, payload, event);

    process.stdout.write(formatMatchedOutput(matched, sessionId));
    process.exit(0);
  } catch {
    process.exit(0);
  }
})();
