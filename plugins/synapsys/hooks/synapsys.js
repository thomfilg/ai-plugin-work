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
const { expectedCommandsFor, resolveAndEmitDivergences } = require(
  path.join(__dirname, 'lib', 'behavior-changed')
);
// Budget-aware renderer (decideInjection policy, reverse-walk demotion, ledger
// commit, cortex_query-augmented body formatting) lives in lib/render-budget.js
// (extracted to keep this dispatcher under the static-gate line budget). The
// dispatcher consumes the destructured entry points below; call sites and
// behavior are byte-for-byte identical.
const { SEP, renderMatchedMemories } = require(path.join(__dirname, '..', 'lib', 'render-budget'));

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const cortexHook = require(path.join(__dirname, '..', 'lib', 'cortex-hook'));
const { scheduleSessionRecall, consumeAutoRecall, cortexQueryContext } = cortexHook;

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
// Cortex auto-recall wiring lives in lib/cortex-hook.js and the budget-aware
// renderer lives in lib/render-budget.js (both extracted to keep this
// dispatcher under the static-gate line budget). The dispatcher consumes the
// destructured entry points pulled in at the top of this file.
// ---------------------------------------------------------------------------

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
