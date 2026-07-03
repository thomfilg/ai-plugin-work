#!/usr/bin/env node
'use strict';

/**
 * Detached background entry point for cortex auto-recall (Task 7, R1/R15).
 *
 * `lib/cortex-recall.scheduleRecall` spawns this script detached with at most
 * two `--query` flags plus `--projectId`, `--sessionId`, and `--home`. The
 * script runs the (≤2) cortex recall calls through an injectable `recallFn`
 * and writes a single session-cache record that `consumeCache` later renders.
 *
 * Two layers, deliberately separated (REFACTOR target):
 *   - `runBackground(...)` — the pure, dependency-injected core. The unit test
 *     drives this directly with a stub `recallFn` and stub `cache`, so no live
 *     cortex tool, filesystem, or model client is involved.
 *   - `main(argv)` — the thin CLI shell that parses argv and wires real deps.
 *
 * Hard constraints: at most two recall calls per session (R15); a failing
 * recall never crashes the process and still yields a written record (R14).
 *
 * @module scripts/synapsys-cortex-recall-bg
 */

const cacheLib = require('../lib/session-cache');

/** Hard cap on cortex calls per background run (R15). */
const MAX_QUERIES = 2;

/**
 * Run a single recall, degrading any failure to an empty result set so one
 * bad query never aborts the whole background run (R14).
 *
 * @param {(query:string, projectId:string)=>Promise<Array>|Array} recallFn
 * @param {string} query
 * @param {string} projectId
 * @returns {Promise<Array>} the results, or [] on failure
 */
async function safeRecall(recallFn, query, projectId) {
  try {
    const results = await recallFn(query, projectId);
    return Array.isArray(results) ? results : [];
  } catch {
    return [];
  }
}

/**
 * Pure background-recall core. Runs at most two recall calls and writes one
 * session-cache record shaped `{ queries: [{ query, projectId, results, ranAt }] }`
 * — exactly what `lib/cortex-recall.consumeCache` / `cortex-format.formatBlock`
 * expect. Never throws: a throwing `recallFn` still produces a written record
 * with empty results for the failed query.
 *
 * @param {{
 *   queries: string[],
 *   projectId: string,
 *   sessionId: string,
 *   recallFn: (query:string, projectId:string)=>Promise<Array>|Array,
 *   cache: { write: (sessionId:string, data:unknown, opts?:object)=>void },
 *   home?: string,
 * }} args
 * @returns {Promise<{queries: Array}>} the written record
 */
async function runBackground({ queries = [], projectId, sessionId, recallFn, cache, home } = {}) {
  const bounded = queries.filter(Boolean).slice(0, MAX_QUERIES);

  const entries = [];
  for (const query of bounded) {
    const results = await safeRecall(recallFn, query, projectId);
    entries.push({
      query,
      projectId,
      results,
      ranAt: new Date().toISOString(),
    });
  }

  const record = { queries: entries };
  cache.write(sessionId, record, { home });
  return record;
}

/**
 * Parse the detached-spawn argv into structured options. Supports repeated
 * `--query` flags (collected into an array) plus single-value `--projectId`,
 * `--sessionId`, and `--home` flags.
 *
 * @param {string[]} argv args after `node script.js`
 * @returns {{ queries: string[], projectId: string, sessionId: string, home: string }}
 */
function parseArgs(argv) {
  const out = { queries: [], projectId: '', sessionId: '', home: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.replace(/^--/, '') : arg.slice(2, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    const value = inline !== undefined ? inline : argv[++i];
    applyArg(out, name, value);
  }
  return out;
}

/**
 * Assign a single parsed `--name value` pair onto the accumulator. `--query`
 * collects into an array (ignoring empties); the single-value flags coerce a
 * missing value to ''. Unknown flags are ignored.
 *
 * @param {{ queries: string[], projectId: string, sessionId: string, home: string }} out
 * @param {string} name flag name (without leading `--`)
 * @param {string|undefined} value flag value
 */
function applyArg(out, name, value) {
  switch (name) {
    case 'query':
      if (value) out.queries.push(value);
      break;
    case 'projectId':
      out.projectId = value || '';
      break;
    case 'sessionId':
      out.sessionId = value || '';
      break;
    case 'home':
      out.home = value || '';
      break;
    default:
      break;
  }
}

/**
 * Resolve the production recall function from `SYNAPSYS_CORTEX_RECALL_MODULE`,
 * the SAME injected-provider contract Phase 2 inline recall uses
 * (`cortex-hook.resolveInlineRecall`). The detached worker inherits the parent
 * process env, so a configured bridge module is honored here too — without this
 * the worker fell straight through to an empty stub and Phase 1 auto-recall
 * never invoked a real `cortex_recall` in production even when a provider was
 * configured (GH-519 review: "Background recall never calls cortex"). Fail-open:
 * an absent / unloadable / malformed module degrades to the empty stub, so
 * shipped hooks with no cortex provider behave exactly as before.
 *
 * @returns {(query:string, projectId:string)=>Promise<Array>|Array}
 */
function resolveRecallFn() {
  const modPath = process.env.SYNAPSYS_CORTEX_RECALL_MODULE;
  if (!modPath) return async () => [];
  try {
    // Dynamic provider require — path comes from SYNAPSYS_CORTEX_RECALL_MODULE.
    const mod = require(modPath);
    if (mod && typeof mod.recall === 'function') return mod.recall.bind(mod);
  } catch {
    // Fall through to the empty stub — never crash the detached process (R14).
  }
  return async () => [];
}

/**
 * CLI shell. Parses argv, wires the real session-cache writer, and resolves a
 * recall function (injectable for tests; production uses
 * `SYNAPSYS_CORTEX_RECALL_MODULE` via resolveRecallFn). Never throws — a
 * top-level failure degrades to a silent no-op so the detached process exits
 * cleanly (R14).
 *
 * @param {string[]} [argv] args after `node script.js` (defaults to process.argv)
 * @param {{
 *   recallFn?: Function,
 *   cache?: { write: Function },
 * }} [deps]
 * @returns {Promise<void>}
 */
async function main(argv = process.argv.slice(2), deps = {}) {
  try {
    const { queries, projectId, sessionId, home } = parseArgs(argv);
    const cache = deps.cache || cacheLib;
    const recallFn = deps.recallFn || resolveRecallFn();
    await runBackground({ queries, projectId, sessionId, recallFn, cache, home });
  } catch {
    // Detached background process — degrade silently (R14).
  }
}

module.exports = { runBackground, main, parseArgs, resolveRecallFn, MAX_QUERIES };

/* istanbul ignore next */
if (require.main === module) {
  main();
}
