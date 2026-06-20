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

const path = require('node:path');
const { discoverStores, listMemoriesFromStore } = require(
  path.join(__dirname, '..', 'lib', 'memory-store')
);
const { selectForEvent } = require(path.join(__dirname, '..', 'lib', 'matcher'));
const { buildActiveDomains } = require(path.join(__dirname, '..', 'lib', 'active-domains'));
const { saveStickyState } = require(path.join(__dirname, '..', 'lib', 'sticky-state'));
const injectLedger = require('../lib/inject-ledger');
const { recordFired, isDisabled } = require(path.join(__dirname, '..', 'lib', 'telemetry'));
const { runCiteScan, runBehaviorScan } = require(path.join(__dirname, '..', 'lib', 'cite-scan'));
const pretoolWindow = require(path.join(__dirname, '..', 'lib', 'pretool-window'));
const { demoteToFit } = require('../lib/budget');
const { expectedCommandsFor, resolveAndEmitDivergences } = require(
  path.join(__dirname, 'lib', 'behavior-changed')
);

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

const cortexHook = require(path.join(__dirname, '..', 'lib', 'cortex-hook'));
const { scheduleSessionRecall, consumeAutoRecall, cortexQueryContext, appendCortexQuery } =
  cortexHook;

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

const { getSessionStartHint } = require(path.join(__dirname, '..', 'lib', 'setup-hints'));

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

function emitMatched(matched, payload, event, sessionId) {
  if (!matched.length) return;
  for (const m of matched) {
    try {
      recordFired(m, payload, event);
    } catch {
      // fail-open
    }
    // Path A: when a memory with a trigger_pretool rule fires on PreToolUse,
    // record the expected command so a subsequent divergent PreToolUse can
    // surface a one-off behavior_changed event.
    if (event === 'PreToolUse' && !isDisabled(m)) {
      const expectedAll = expectedCommandsFor(m);
      if (expectedAll.length > 0) {
        try {
          pretoolWindow.recordExpectation(sessionId, m.name, expectedAll);
        } catch {
          // fail-open
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Cortex auto-recall wiring lives in lib/cortex-hook.js (extracted to keep this
// dispatcher under the static-gate line budget). The dispatcher consumes the
// destructured entry points pulled in at the top of this file.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Dispatcher entry point
// ---------------------------------------------------------------------------

/**
 * Resolve the session id for the dispatch and publish it to `.current` so
 * out-of-process callers (synapsys-list CLI) read the same session ledger the
 * dispatcher writes to. Fail-open: any throw → '' and the dispatcher behaves
 * like the pre-ledger code path.
 */
function resolveSessionForPayload(payload) {
  try {
    const sessionId = injectLedger.resolveSessionId(payload);
    injectLedger.publishCurrentSessionId(sessionId);
    return sessionId;
  } catch {
    return '';
  }
}

/**
 * SessionStart housekeeping: reset the per-session ledger (brief AC-4 / spec
 * §3.3) and opportunistically GC stale ledger files older than 7 days (spec
 * §4.2). Fail-open.
 */
function maybeResetSessionLedger(event, sessionId) {
  if (event !== 'SessionStart') return;
  try {
    injectLedger.resetLedgerForSession(sessionId);
    injectLedger.gcStaleLedgers({ maxAgeMs: SEVEN_DAYS_MS });
  } catch {
    /* fail-open */
  }
}

/**
 * Assemble the final injection text: the Phase 1 auto-recall block (prepended)
 * plus the budget-aware rendered memory output. Returns '' when neither
 * produces content. Both halves are independently budget-governed.
 */
function buildOutput(autoBlock, matched, sessionId, payload) {
  const sections = [];
  if (autoBlock) sections.push(autoBlock);
  const memOutput = matched.length ? formatMatchedOutput(matched, sessionId, payload) : '';
  if (memOutput) sections.push(memOutput);
  return sections.join(SEP);
}

/**
 * Stop-time scans. The cite scan reads the session JSONL state from BEFORE
 * this turn's Stop-time fired writes (Stop-injections happen after the
 * assistant response, so attributing citations to them would be a false
 * positive). Also runs the behavior-changed scan and clears the per-turn
 * pretool-window dedup. Each scan is independently fail-open.
 */
function runStopScans(payload, memories, sessionId) {
  try {
    runCiteScan(payload, memories);
  } catch {
    // fail-open
  }
  try {
    runBehaviorScan(payload, memories, sessionId);
  } catch {
    // fail-open
  }
  try {
    pretoolWindow.clearTurnDedup(sessionId);
  } catch {
    // fail-open
  }
}

async function dispatch() {
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
  const sessionId = resolveSessionForPayload(payload);
  maybeResetSessionLedger(event, sessionId);

  // UserPromptSubmit: the Phase 1 auto-recall block is prepended to any memory
  // output (consumes + deletes the background recall cache).
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
  // Path A on PreToolUse: resolve pending expectations against the observed
  // command BEFORE recording new ones, so a memory firing this turn does not
  // immediately get aged out by its own observed command.
  if (event === 'PreToolUse') {
    resolveAndEmitDivergences(payload, memories, sessionId);
  }
  if (event === 'Stop') {
    runStopScans(payload, memories, sessionId);
  }
  emitMatched(matched, payload, event, sessionId);

  // Assemble the Phase 1 auto-recall block (prepended) with the budget-aware
  // rendered memory output. Memory text is already governed by the renderer
  // (demote, don't truncate); the auto-recall block is independently bounded
  // by the cortex config. No hard clamp here — that would contradict the
  // graceful-demotion contract (dispatcher-budget).
  const output = buildOutput(autoBlock, matched, sessionId, payload);
  if (!output) process.exit(0);
  process.stdout.write(output);
  process.exit(0);
}

(async () => {
  try {
    await dispatch();
  } catch {
    process.exit(0);
  }
})();
