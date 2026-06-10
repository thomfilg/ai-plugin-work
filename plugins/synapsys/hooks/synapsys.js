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
 *
 * Cortex auto-recall (Task 9, R1/R7/R13/R14/R18):
 *   - SessionStart fires a detached, fire-and-forget background recall of up to
 *     two queries (the ticket id + a derived keyword query) via
 *     `cortex-recall.scheduleRecall`. Results land in a session-cache file.
 *   - UserPromptSubmit consumes that cache and prepends a `[cortex:auto-recall]`
 *     block to the normal injection output, then deletes the cache (single
 *     consume).
 *   - Any fired memory carrying a `cortex_query` frontmatter field triggers an
 *     inline recall whose formatted results are appended below the memory body.
 *     This path is additive: memories without the field are byte-for-byte
 *     unchanged, and the whole feature degrades silently when cortex is
 *     unavailable.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverStores, listMemoriesFromStore } = require(
  path.join(__dirname, '..', 'lib', 'memory-store')
);
const { selectForEvent } = require(path.join(__dirname, '..', 'lib', 'matcher'));
const { buildActiveDomains } = require(path.join(__dirname, '..', 'lib', 'active-domains'));
const { saveStickyState } = require(path.join(__dirname, '..', 'lib', 'sticky-state'));
const injectLedger = require('../lib/inject-ledger');
const { recordFired } = require(path.join(__dirname, '..', 'lib', 'telemetry'));
const { runCiteScan } = require(path.join(__dirname, '..', 'lib', 'cite-scan'));
const { demoteToFit } = require('../lib/budget');

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Budget constants (brief P0 R1 / R3 / spec §P0 #1).
//
// MAX_INJECT_CHARS — soft cap on total injected text. Memories that cause the
//   matched set to exceed this limit are demoted to summary form (reverse-walk),
//   never silently dropped (brief P0 R8 / spec §P0 #8).
// SKIP_DEMOTION_BELOW — memories whose full body is below this size are never
//   chosen for demotion: their full text is small enough to always inject
//   in full (brief P0 R3 / spec §P0 #3).
//
// Both may be overridden at runtime via `SYNAPSYS_INJECT_BUDGET` (positive
// integer; brief P2 R12 / spec §P2 #1). See `resolveActiveBudget`.
// ─────────────────────────────────────────────────────────────────────────────
const MAX_INJECT_CHARS = 16000;
const SKIP_DEMOTION_BELOW = 2000;

function resolveActiveBudget() {
  const raw = process.env.SYNAPSYS_INJECT_BUDGET;
  if (raw == null || raw === '') return MAX_INJECT_CHARS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MAX_INJECT_CHARS;
}

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

// Budget-aware renderer (brief P0 R1/R2/R4–R8). After the per-memory
// decideInjection pass, run a reverse-walk demotion to bring the total under
// `activeBudget`. Ledger semantics (brief P0 R6):
//   initialKind='full'  && finalKind='full'     → commitInjection(..., true)
//   initialKind='reminder'                       → commitInjection(..., false)
//   initialKind='full'  && finalKind='reminder' → NO commitInjection (re-fires
//                                                  in full on the next match).
// The whole call is wrapped in `try` so any throw falls open to the plain
// formatMemory join — memory injection must never block the user (spec §Security).
function buildEntry(memory, ledgerMemories, cortexCtx) {
  const kind = decideInjection(memory, ledgerMemories[memory.name]).kind;
  return {
    memory,
    initialKind: kind,
    finalKind: kind,
    fullText: formatMemoryForRender(memory, cortexCtx),
    summaryText: reminderLine(memory),
  };
}

function emitEntries(entries, ledger, sessionId) {
  let demotedCount = 0;
  const pieces = [];
  for (const e of entries) {
    const isFull = e.finalKind === 'full';
    pieces.push(isFull ? e.fullText : e.summaryText);
    if (e.initialKind === 'full' && e.finalKind === 'reminder') {
      // Budget-induced demotion: do NOT bump the ledger so the memory
      // re-fires in full on the next match (brief P0 R6 / G5).
      demotedCount += 1;
      continue;
    }
    commitInjection(ledger, sessionId, e.memory, isFull);
  }
  return { body: pieces.join(SEP), demotedCount };
}

function writeStderrLine(line) {
  try {
    process.stderr.write(line);
  } catch {
    /* fail-open */
  }
}

function emitBudgetAlerts(demotedCount, bodyLength, activeBudget) {
  // Stderr alert (brief P0 R7 / spec §Security: count-only, no names/bodies).
  if (demotedCount > 0) {
    writeStderrLine(
      `[synapsys] ${demotedCount} memories summarized to fit ${activeBudget}-char budget — they will inject in full on next match.\n`
    );
  }
  // Debug stderr line when SYNAPSYS_DEBUG=1 (brief P1 R11).
  if (process.env.SYNAPSYS_DEBUG === '1') {
    writeStderrLine(`[synapsys:debug] budget ${bodyLength}/${activeBudget}\n`);
  }
}

function renderMatchedMemories(matched, sessionId, cortexCtx) {
  try {
    const ledger = injectLedger.loadLedger(sessionId);
    if (!ledger.memories || typeof ledger.memories !== 'object') {
      ledger.memories = {};
    }
    const activeBudget = resolveActiveBudget();
    const entries = matched.map((m) => buildEntry(m, ledger.memories, cortexCtx));
    demoteToFit(entries, {
      limit: activeBudget,
      sep: SEP,
      skipBelow: SKIP_DEMOTION_BELOW,
    });
    const { body, demotedCount } = emitEntries(entries, ledger, sessionId);
    emitBudgetAlerts(demotedCount, body.length, activeBudget);
    return body;
  } catch {
    return matched.map((m) => formatMemoryForRender(m, null)).join(SEP);
  }
}

const cortexRecall = require(path.join(__dirname, '..', 'lib', 'cortex-recall'));
const sessionCache = require(path.join(__dirname, '..', 'lib', 'session-cache'));
const cortexConfig = require(path.join(__dirname, '..', 'lib', 'cortex-config'));
const { formatBlock } = require(path.join(__dirname, '..', 'lib', 'cortex-format'));

const VALID_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']);

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

// Build the activeDomains opts for selectForEvent. Delegates to the
// shared resolver so synapsys-explain stays in lockstep. Uses the
// injectLedger session-id resolver so sticky-state, ledger, and telemetry
// all key off the same session, and persists the next sticky state on
// UserPromptSubmit via saveStickyState (the read-only CLI omits this).
function buildActiveDomainsForPayload(event, payload) {
  const activeDomains = buildActiveDomains(event, payload, {
    resolveSessionId: injectLedger.resolveSessionId,
    onPersistSticky: (state) => saveStickyState({ state }),
  });
  return activeDomains ? { activeDomains } : undefined;
}

// Pass-through wrapper retained for call-site symmetry. The renderer now owns
// the budget pass (demote-instead-of-drop), so no slice fallback is needed —
// brief P0 R8 / spec §P0 #8 explicitly forbids silent truncation.
function formatMatchedOutput(matched, sessionId, payload) {
  return renderMatchedMemories(matched, sessionId, cortexQueryContext(payload));
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

// ---------------------------------------------------------------------------
// Cortex auto-recall wiring
// ---------------------------------------------------------------------------

/** Resolve the cache/home root used by the session cache + background recall. */
function recallHome() {
  return process.env.HOME || os.homedir();
}

/** Resolve a session id from the payload, falling back to a stable token. */
function sessionIdOf(payload) {
  return String(payload.session_id || payload.sessionId || 'default');
}

/**
 * Load the cortex config and decide whether auto-recall should run for this
 * environment. Never throws.
 */
function recallEnabled(home) {
  try {
    const config = cortexConfig.loadConfig({ home, env: process.env });
    return { config, enabled: cortexRecall.shouldRun(process.env, config) };
  } catch {
    return { config: cortexConfig.DEFAULTS, enabled: false };
  }
}

/**
 * SessionStart: schedule the (≤2) fire-and-forget background recall. Honors the
 * kill-switch / config gate and is entirely fail-open (R1, R14, R15).
 */
function scheduleSessionRecall(payload) {
  const home = recallHome();
  const { enabled } = recallEnabled(home);
  if (!enabled) return;

  try {
    const cwd = payload.cwd || process.cwd();
    const projectId = cortexRecall.resolveProjectId(cwd, { env: process.env });
    const ticketId = cortexRecall.resolveTicketId(cwd, { env: process.env });

    // Derived keyword query — test/CI override skips the live git extraction so
    // the second query is deterministic without a working tree.
    let keywordQuery = String(process.env.SYNAPSYS_CORTEX_KEYWORDS || '').trim();
    if (!keywordQuery) {
      const keywords = cortexRecall.deriveKeywords({ ticketId, cwd });
      keywordQuery = keywords.join(' ');
    }

    const queries = [ticketId, keywordQuery].filter(Boolean);
    const sessionId = sessionIdOf(payload);

    // Write a synchronous baseline record (the scheduled queries with empty
    // results) BEFORE spawning the detached recall. This guarantees a
    // consumable cache exists the instant SessionStart returns — the next
    // UserPromptSubmit always has something to render even if the detached
    // child has not finished — and the detached process overwrites it with the
    // real cortex results when it completes. The write is a single small JSON
    // file, so SessionStart stays effectively non-blocking (R1).
    writeBaselineRecall({ queries, projectId, sessionId, home });

    cortexRecall.scheduleRecall({
      queries,
      projectId,
      sessionId,
      home,
    });
  } catch {
    // Graceful degrade — never block SessionStart (R14).
  }
}

/**
 * Synchronously write the baseline session-cache record for the scheduled
 * queries (empty results), matching the `{ queries: [{ query, projectId,
 * results, ranAt }] }` shape `consumeCache` / `formatBlock` expect. Never
 * throws.
 */
function writeBaselineRecall({ queries, projectId, sessionId, home }) {
  try {
    const record = {
      queries: queries.map((query) => ({
        query,
        projectId,
        results: [],
        ranAt: new Date().toISOString(),
      })),
    };
    sessionCache.write(sessionId, record, { home });
  } catch {
    // Best-effort baseline — the detached recall is the source of truth.
  }
}

/**
 * Build the Phase 1 auto-recall block for UserPromptSubmit by consuming the
 * background cache (single-consume; deletes the cache). Returns '' when there
 * is nothing to inject. Never throws.
 */
function consumeAutoRecall(payload) {
  const home = recallHome();
  const { config, enabled } = recallEnabled(home);
  if (!enabled) return '';
  try {
    return cortexRecall.consumeCache(sessionIdOf(payload), { home, config });
  } catch {
    return '';
  }
}

/** Path of the per-session fire-mode marker for a Phase 2 cortex_query. */
function fireMarkerFile(home, sessionId, key) {
  const safe = String(key)
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .slice(0, 80);
  return path.join(home, '.claude', 'synapsys', '.cache', `cq-${sessionId}-${safe}.fired`);
}

/**
 * Returns true when a `fire_mode` of `once_per_session` should suppress a repeat
 * Phase 2 run for this memory in this session. Marks the memory as fired as a
 * side effect when it has a once-per-session fire mode. Fail-open: any fs error
 * leaves the query un-suppressed.
 */
function suppressedByFireMode(home, sessionId, memory) {
  const mode = String(memory.meta?.fire_mode || '').toLowerCase();
  const oncePerSession = mode === 'once_per_session' || mode === 'once';
  if (!oncePerSession) return false;

  const key = `${memory.name}:${memory.meta.cortex_query}`;
  const marker = fireMarkerFile(home, sessionId, key);
  try {
    if (fs.existsSync(marker)) return true;
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '1');
  } catch {
    // Could not read/write the marker — do not suppress.
  }
  return false;
}

/** Resolve the injectable inline-recall function, or null when unavailable. */
function resolveInlineRecall() {
  const modPath = process.env.SYNAPSYS_CORTEX_RECALL_MODULE;
  if (!modPath) return null;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const mod = require(modPath);
    return typeof mod.recall === 'function' ? mod.recall.bind(mod) : null;
  } catch {
    return null;
  }
}

/**
 * Phase 2: for each fired memory carrying `meta.cortex_query`, run the inline
 * recall and append the formatted results below the rendered memory body.
 * Backward compatible — memories without the field are returned unchanged.
 * Honors `fire_mode` suppression within a session. Never throws.
 *
 * @param {Array<object>} matched fired memories
 * @param {object} payload hook payload
 * @returns {string[]} the per-memory rendered strings (body + optional append)
 */
function cortexQueryContext(payload) {
  const home = recallHome();
  const { config, enabled } = recallEnabled(home);
  const recall = enabled ? resolveInlineRecall() : null;
  const sessionId = sessionIdOf(payload || {});
  let projectId = '';
  try {
    projectId = cortexRecall.resolveProjectId((payload && payload.cwd) || process.cwd(), {
      env: process.env,
    });
  } catch {
    projectId = '';
  }
  return { home, config, enabled, recall, sessionId, projectId };
}

/**
 * Append a Phase 2 cortex_query recall block beneath a memory's rendered body.
 * Returns `base` unchanged when the memory has no `cortex_query`, when inline
 * recall is unavailable, or when `fire_mode` suppresses a repeat. Never throws.
 */
function appendCortexQuery(base, memory, ctx) {
  const query = memory.meta?.cortex_query;
  if (!query || !ctx || !ctx.recall) return base;
  if (suppressedByFireMode(ctx.home, ctx.sessionId, memory)) return base;

  try {
    const result = ctx.recall(String(query), ctx.projectId);
    const queryRecord = normalizeRecall(result, String(query), ctx.projectId);
    const block = formatBlock({
      queries: [queryRecord],
      maxAgeDays: ctx.config.max_age_days ?? 180,
      maxChars: ctx.config.max_chars_per_memory ?? 500,
    });
    return block ? `${base}\n\n${block}` : base;
  } catch {
    // Inline recall failed — leave the memory body unchanged (R14/R18).
    return base;
  }
}

/**
 * Render a memory's full body, augmented with its Phase 2 cortex_query block
 * when one applies. `cortexCtx` is built once per dispatch by
 * `cortexQueryContext`; a null ctx (e.g. fail-open fallback paths) yields the
 * plain body. This is the body fed into the budget-aware renderer so cortex
 * recall output is governed by the same injection budget as memory text.
 */
function formatMemoryForRender(memory, cortexCtx) {
  const base = formatMemory(memory);
  if (!cortexCtx || !cortexCtx.recall) return base;
  return appendCortexQuery(base, memory, cortexCtx);
}

/**
 * Coerce an inline-recall return into the `{ query, projectId, results }` shape
 * `formatBlock` consumes. Accepts either that object directly or a bare results
 * array.
 */
function normalizeRecall(result, query, projectId) {
  if (Array.isArray(result)) return { query, projectId, results: result };
  if (result && typeof result === 'object') {
    return {
      query: result.query || query,
      projectId: result.projectId || projectId,
      results: Array.isArray(result.results) ? result.results : [],
    };
  }
  return { query, projectId, results: [] };
}

(async () => {
  try {
    const event = process.argv[2];
    if (!VALID_EVENTS.has(event)) process.exit(0);

    const payload = parsePayload(await readStdin());
    const cwd = payload.cwd || process.cwd();

    // SessionStart: kick off the detached background recall before anything else.
    if (event === 'SessionStart') scheduleSessionRecall(payload);

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

    // UserPromptSubmit: the Phase 1 auto-recall block is prepended to any
    // memory output (consumes + deletes the background recall cache).
    const autoBlock = event === 'UserPromptSubmit' ? consumeAutoRecall(payload) : '';

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

    // Phase 1 auto-recall is prepended; matched memories render through the
    // budget-aware renderer, which also appends per-memory Phase 2 cortex_query
    // results (so recall output is governed by the same injection budget).
    const sections = [];
    if (autoBlock) sections.push(autoBlock);
    const memOutput = matched.length ? formatMatchedOutput(matched, sessionId, payload) : '';
    if (memOutput) sections.push(memOutput);

    if (!sections.length) process.exit(0);
    // Memory text is already governed by the budget-aware renderer (demote,
    // don't truncate); the Phase 1 auto-recall block is independently bounded
    // by the cortex config. No hard clamp here — that would contradict the
    // graceful-demotion contract (dispatcher-budget).
    process.stdout.write(sections.join(SEP));
    process.exit(0);
  } catch {
    process.exit(0);
  }
})();
