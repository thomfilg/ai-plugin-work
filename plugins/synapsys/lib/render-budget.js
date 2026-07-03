'use strict';

/**
 * Budget-aware memory renderer (extracted from hooks/synapsys.js to keep the
 * dispatcher under the static-gate line budget).
 *
 * This module owns the per-memory injection policy (decideInjection), the
 * reverse-walk budget demotion (renderMatchedMemories → demoteToFit), the
 * ledger commit semantics, and the cortex_query-augmented body formatting.
 * The dispatcher consumes `renderMatchedMemories`, `formatMemoryForRender`,
 * and the shared `SEP` separator. Behavior is byte-for-byte identical to the
 * pre-extraction inline implementation.
 */

const path = require('node:path');
const injectLedger = require(path.join(__dirname, 'inject-ledger'));
const { demoteToFit } = require(path.join(__dirname, 'budget'));
const { appendCortexQuery } = require(path.join(__dirname, 'cortex-hook'));

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
const SEP = '\n\n---\n\n';

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

function formatMemory(m) {
  const header = `[synapsys:${m.store.kind}] ${m.name} — ${m.description || '(no description)'}`;
  if (m.inject === 'full') {
    return `${header}\n\n${m.body.trim()}`;
  }
  return `${header}\n  source: ${m.file}`;
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
function buildEntry(memory, ledgerMemories, cortexCtx, subagentNames) {
  // Subagent-propagated (prompt-scope) matches render full: the spawned subagent
  // is a fresh context that has never seen the memory, so the parent session's
  // inject-ledger reminder demotion must not apply (PR #605, Cursor "Subagent
  // context uses reminder ledger"). Budget demotion (demoteToFit) still applies.
  const subagentOrigin = !!(subagentNames && subagentNames.has(memory.name));
  const kind = subagentOrigin ? 'full' : decideInjection(memory, ledgerMemories[memory.name]).kind;
  return {
    memory,
    cortexCtx,
    subagentOrigin,
    initialKind: kind,
    finalKind: kind,
    // Base body only. The Phase 2 `cortex_query` block is appended lazily in
    // emitEntries — and ONLY for entries that survive demotion as `full`. A
    // memory demoted to a reminder by the budget pass therefore never runs its
    // inline cortex recall nor burns its once-per-session fire marker for
    // output the user never sees (GH-519 review: "Demoted memories still run
    // recall"). Demotion sizing uses the base body; the appended cortex block
    // is bounded by max_results/max_chars and tolerated by demote-not-drop.
    fullText: formatMemory(memory),
    summaryText: reminderLine(memory),
  };
}

function emitEntries(entries, ledger, sessionId) {
  let demotedCount = 0;
  const pieces = [];
  for (const e of entries) {
    const isFull = e.finalKind === 'full';
    // Run the Phase 2 cortex_query append (recall + fire-marker side effects)
    // only now, for entries actually rendered in full. appendCortexQuery is a
    // no-op when cortexCtx is null / the memory has no cortex_query.
    pieces.push(isFull ? appendCortexQuery(e.fullText, e.memory, e.cortexCtx) : e.summaryText);
    if (e.initialKind === 'full' && e.finalKind === 'reminder') {
      // Budget-induced demotion: do NOT bump the ledger so the memory
      // re-fires in full on the next match (brief P0 R6 / G5).
      demotedCount += 1;
      continue;
    }
    // Subagent-propagated matches inject into a separate fresh subagent context,
    // NOT the main session. Bumping the parent ledger here would demote a later
    // main-thread match of the same memory to a one-line reminder for a body the
    // main context never received (PR #605 review B1 — the read-side
    // force-full's mirror image on the write side).
    if (e.subagentOrigin) continue;
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

/**
 * renderMatchedMemories — per-memory loop wrapper. Routes each match through
 * the ledger + decideInjection + recordInjection. The entire call is fail-open
 * (R1): any throw → fall back to formatting every memory as full body.
 */
function renderMatchedMemories(matched, sessionId, cortexCtx, subagentNames) {
  try {
    const ledger = injectLedger.loadLedger(sessionId);
    if (!ledger.memories || typeof ledger.memories !== 'object') {
      ledger.memories = {};
    }
    const activeBudget = resolveActiveBudget();
    const entries = matched.map((m) => buildEntry(m, ledger.memories, cortexCtx, subagentNames));
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

module.exports = {
  SEP,
  MAX_INJECT_CHARS,
  SKIP_DEMOTION_BELOW,
  resolveActiveBudget,
  resolveCadence,
  decideInjection,
  formatMemory,
  formatMemoryForRender,
  renderMatchedMemories,
};
