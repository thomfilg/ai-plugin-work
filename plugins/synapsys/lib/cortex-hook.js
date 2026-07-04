'use strict';

/**
 * Cortex auto-recall hook wiring.
 *
 * Houses the pure helpers the synapsys dispatcher uses to drive the cortex
 * auto-recall lifecycle, extracted from `hooks/synapsys.js` to keep the hook
 * dispatcher under the static-gate line budget. No behavior change — these are
 * the same functions, byte-for-byte, relocated behind a module boundary.
 *
 *   - scheduleSessionRecall — SessionStart fire-and-forget background recall
 *   - consumeAutoRecall      — UserPromptSubmit Phase 1 cache consume
 *   - cortexQueryContext     — per-dispatch Phase 2 context
 *   - appendCortexQuery      — Phase 2 per-memory cortex_query append
 *   - formatMemoryForRender  — full body + optional Phase 2 block
 *
 * Every entry point is fail-open (R1/R14/R18): any throw degrades to the plain
 * memory body / a silent no-op and never blocks the dispatcher.
 *
 * @module lib/cortex-hook
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cortexRecall = require(path.join(__dirname, 'cortex-recall'));
const sessionCache = require(path.join(__dirname, 'session-cache'));
const consumeSentinel = require(path.join(__dirname, 'consume-sentinel'));
const cortexConfig = require(path.join(__dirname, 'cortex-config'));
const injectLedger = require(path.join(__dirname, 'inject-ledger'));
const { formatBlock } = require(path.join(__dirname, 'cortex-format'));

/** Resolve the cache/home root used by the session cache + background recall. */
function recallHome() {
  return process.env.HOME || os.homedir();
}

/**
 * Resolve a session id for the cortex auto-recall cache.
 *
 * Routes through `injectLedger.resolveSessionId` — the SAME resolver the hook's
 * ledger, telemetry, and sticky-state use — so the cortex cache is written and
 * consumed under exactly the id the live session is keyed on (env
 * `CLAUDE_CODE_SESSION_ID` → sanitized `payload.session_id` → `.current` →
 * hashed-cwd fallback). Sharing one resolver prevents the cache being written
 * under one id and read under another. `scripts/synapsys-recall.js` resolves
 * through the same function so `/synapsys recall` reads what the hook wrote.
 */
function sessionIdOf(payload) {
  return injectLedger.resolveSessionId(payload || {});
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
 * Build the (≤2) recall queries for SessionStart. The keyword query honors a
 * test/CI override (`SYNAPSYS_CORTEX_KEYWORDS`) that skips the live git
 * extraction so the second query is deterministic without a working tree.
 * `config.max_keywords` caps the derived keyword count (GH-519 review: the
 * documented YAML knob must take effect, not the hardcoded default).
 */
function buildSessionQueries(cwd, config = {}) {
  const projectId = cortexRecall.resolveProjectId(cwd, { env: process.env });
  const ticketId = cortexRecall.resolveTicketId(cwd, { env: process.env });

  let keywordQuery = String(process.env.SYNAPSYS_CORTEX_KEYWORDS || '').trim();
  if (!keywordQuery) {
    const opts = config.max_keywords != null ? { maxKeywords: config.max_keywords } : {};
    const keywords = cortexRecall.deriveKeywords({ ticketId, cwd }, opts);
    keywordQuery = keywords.join(' ');
  }

  return { projectId, queries: [ticketId, keywordQuery].filter(Boolean) };
}

/**
 * SessionStart: schedule the (≤2) fire-and-forget background recall. Honors the
 * kill-switch / config gate and is entirely fail-open (R1, R14, R15).
 */
function scheduleSessionRecall(payload) {
  const home = recallHome();
  const { config, enabled } = recallEnabled(home);
  if (!enabled) return;
  // Per-path config sub-switch: `on_session_start:false` disables the
  // SessionStart background recall while leaving the Phase 2 per-memory path
  // (`on_memory_fire`) untouched.
  if (config.on_session_start === false) return;

  try {
    // Gate BEFORE any derivation (cheap, no network). No resolvable recall
    // provider → Phase 1 is silently disabled: the shipped default has no
    // provider, so without this the detached worker writes empty results and the
    // next prompt injects a "→ no matches" marker that falsely claims cortex ran
    // when it never did (GH-519 review: baseline marker lies). Returning here
    // also means the networked `gh issue view` keyword derivation never runs in
    // the default case, keeping SessionStart non-blocking (R1).
    if (resolveInlineRecall() == null) return;

    const sessionId = sessionIdOf(payload);
    // Skip when this session already consumed Phase 1: a repeat SessionStart
    // (resume/compact) would otherwise spawn recall work the sentinel discards
    // (GH-519: rerun-recall-after-consume).
    if (consumeSentinel.isConsumed(sessionCache, sessionId, home)) return;

    const cwd = payload.cwd || process.cwd();
    const { projectId, queries } = buildSessionQueries(cwd, config);

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
      // `baseline:true` marks this as the pre-recall placeholder so consumeCache
      // defers instead of single-consuming empty results before the detached job
      // lands (GH-519: early-consume-drops-recall). The background write never
      // carries this flag, so the real results consume normally.
      baseline: true,
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
  try {
    // Always consume the cache — even when auto-recall is disabled — so an
    // existing SessionStart cache is marked with the single-consume sentinel
    // and deleted on this first prompt. Skipping cleanup would let a later
    // prompt (with recall re-enabled) inject Phase 1 output on the wrong turn.
    const block = cortexRecall.consumeCache(sessionIdOf(payload), { home, config });
    return enabled ? block : '';
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
  // Resolve the effective mode from the parsed `memory.fireMode` (default
  // `once` via parseFireMode) so Phase 2 suppression matches the injection
  // cadence in render-budget's decideInjection. Fall back to the raw
  // frontmatter string, then to `once`, when the parsed field is absent.
  const mode = String(memory.fireMode || memory.meta?.fire_mode || 'once').toLowerCase();
  const oncePerSession = mode === 'once_per_session' || mode === 'once';
  if (!oncePerSession) return false;

  const key = `${memory.name}:${memory.meta?.cortex_query}`;
  const marker = fireMarkerFile(home, sessionId, key);
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    // Atomic create-or-fail (flag 'wx') — no check-then-act TOCTOU window. A
    // successful write means this is the first fire (not suppressed); an
    // EEXIST means the marker already exists this session (suppress). Any
    // other fs error falls open to "do not suppress".
    fs.writeFileSync(marker, '1', { flag: 'wx' });
    return false;
  } catch (err) {
    return !!(err && err.code === 'EEXIST');
  }
}

/**
 * Release a once-per-session fire marker so the memory's cortex_query can fire
 * again later in this session. Called when the recall this dispatch claimed the
 * marker for throws — otherwise a transient recall failure would permanently
 * (fail-closed) suppress the query for the rest of the session. The atomic
 * `wx`-create claim in suppressedByFireMode stays intact; this only undoes the
 * claim on failure. Best-effort: a missing marker (non-once mode, or never
 * claimed) or any unlink error is ignored.
 */
function releaseFireMarker(home, sessionId, memory) {
  const key = `${memory.name}:${memory.meta?.cortex_query}`;
  try {
    fs.unlinkSync(fireMarkerFile(home, sessionId, key));
  } catch {
    // No marker to release (non-once mode / never claimed) or fs error — ignore.
  }
}

/**
 * Resolve the injectable inline-recall function, or null when unavailable.
 *
 * PRODUCTION CONTRACT: cortex is reached through a provider module named by
 * `SYNAPSYS_CORTEX_RECALL_MODULE` (exporting `recall(query, projectId)`), NOT by
 * calling the MCP tool — the hook (and the detached Phase 1 worker) cannot
 * invoke an MCP tool, which only the live agent can reach. The shipped hook sets
 * no default module, so auto-recall is opt-in: with the var unset both phases
 * resolve to an empty stub and inject nothing (by design). See README
 * "Recall provider". Fail-open: an unset/unloadable/malformed module → null.
 */
function resolveInlineRecall() {
  const modPath = process.env.SYNAPSYS_CORTEX_RECALL_MODULE;
  if (!modPath) return null;
  try {
    // Dynamic provider require — path comes from SYNAPSYS_CORTEX_RECALL_MODULE.
    const mod = require(modPath);
    return typeof mod.recall === 'function' ? mod.recall.bind(mod) : null;
  } catch {
    return null;
  }
}

/**
 * Build the per-dispatch Phase 2 context once (R1). A null `recall` (cortex
 * disabled/unavailable) yields the plain memory body downstream.
 *
 * @param {object} payload hook payload
 * @returns {{ home: string, config: object, enabled: boolean, recall: Function|null, sessionId: string, projectId: string }}
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
 * Guard the Phase 2 append: returns true when the cortex_query recall must be
 * skipped for this memory (no query, no inline recall, the `on_memory_fire`
 * sub-switch is off, or `fire_mode` suppresses a repeat in this session).
 */
function shouldSkipCortexQuery(query, memory, ctx) {
  if (!query || !ctx || !ctx.recall) return true;
  // Per-path config sub-switch: `on_memory_fire:false` disables the Phase 2
  // per-memory cortex_query append while leaving the SessionStart path
  // (`on_session_start`) untouched.
  if (ctx.config && ctx.config.on_memory_fire === false) return true;
  return suppressedByFireMode(ctx.home, ctx.sessionId, memory);
}

/**
 * Append a Phase 2 cortex_query recall block beneath a memory's rendered body.
 * Returns `base` unchanged when the memory has no `cortex_query`, when inline
 * recall is unavailable, or when `fire_mode` suppresses a repeat. Never throws.
 */
function appendCortexQuery(base, memory, ctx) {
  const query = memory.meta?.cortex_query;
  if (shouldSkipCortexQuery(query, memory, ctx)) return base;

  try {
    const result = ctx.recall(String(query), ctx.projectId);
    const queryRecord = normalizeRecall(result, String(query), ctx.projectId);
    const block = formatBlock({
      queries: [queryRecord],
      maxAgeDays: ctx.config.max_age_days ?? 180,
      maxChars: ctx.config.max_chars_per_memory ?? 500,
      maxResults: ctx.config.max_results_per_query ?? 5,
    });
    return block ? `${base}\n\n${block}` : base;
  } catch {
    // Inline recall failed — leave the memory body unchanged (R14/R18) and
    // release the once-per-session marker shouldSkipCortexQuery just claimed so
    // a transient failure does not permanently suppress this query (fail-open,
    // not fail-closed).
    releaseFireMarker(ctx.home, ctx.sessionId, memory);
    return base;
  }
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

module.exports = {
  recallHome,
  sessionIdOf,
  recallEnabled,
  scheduleSessionRecall,
  buildSessionQueries,
  writeBaselineRecall,
  consumeAutoRecall,
  fireMarkerFile,
  suppressedByFireMode,
  resolveInlineRecall,
  cortexQueryContext,
  appendCortexQuery,
  normalizeRecall,
};
