'use strict';

/**
 * Default cortex recall bridge (GH-662) — zero-config provider that reads the
 * cortex memory store (`~/.cortex/memory.db`, SQLite) directly, read-only.
 *
 * This is the shipped fallback behind `lib/cortex-provider.js`: when
 * `SYNAPSYS_CORTEX_RECALL_MODULE` is unset and a cortex db is detectable, both
 * auto-recall phases use this module's `recall(query, projectId)` instead of
 * silently disabling. An explicitly configured module ALWAYS wins — this
 * bridge is never a fallback for a broken module (see cortex-provider).
 *
 * Honest scope: the db stores embeddings but the hook path has no embedder, so
 * this bridge does keyword+recency recall, NOT semantic search. Rows are
 * ranked by matched-keyword count, then recency, capped at 5.
 *
 * SQLite access uses `node:sqlite` (Node >= 22.5, experimental) — probed once
 * in a try/catch so Node 20 degrades to "unavailable" instead of crashing.
 * Every entry point is fail-open: any error → unavailable / empty results.
 *
 * @module lib/cortex-bridge
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** Max results per recall call — downstream re-caps via max_results_per_query. */
const MAX_RESULTS = 5;

/** Tokens too generic to discriminate; dropped before the LIKE match. */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'into',
  'use',
  'using',
]);

/**
 * Probe result for `node:sqlite`, cached so the ExperimentalWarning the require
 * prints on stderr is emitted at most once per process.
 * @type {{ mod: object|null }|null}
 */
let sqliteProbe = null;

/** Load `node:sqlite` once; null when this Node has no sqlite (< 22.5). */
function loadSqlite() {
  if (sqliteProbe) return sqliteProbe.mod;
  try {
    const mod = require('node:sqlite');
    sqliteProbe = { mod: typeof mod.DatabaseSync === 'function' ? mod : null };
  } catch {
    sqliteProbe = { mod: null };
  }
  return sqliteProbe.mod;
}

/**
 * Resolve the cortex db path: `SYNAPSYS_CORTEX_DB` override, else
 * `<home>/.cortex/memory.db`.
 *
 * @param {{ home?: string, env?: object }} [opts]
 * @returns {string}
 */
function dbPath({ home, env } = {}) {
  const e = env || process.env;
  const override = String(e.SYNAPSYS_CORTEX_DB || '').trim();
  if (override) return override;
  const h = home || e.HOME || os.homedir();
  return path.join(h, '.cortex', 'memory.db');
}

/**
 * Detect whether the default bridge can serve recalls in this environment:
 * `node:sqlite` loadable, the db file exists, it opens read-only, and it has a
 * `memories` table. Never throws.
 *
 * @param {{ home?: string, env?: object }} [opts]
 * @returns {{ available: boolean, reason: string }}
 */
function detect(opts = {}) {
  const sqlite = loadSqlite();
  if (!sqlite) {
    return { available: false, reason: 'node:sqlite unavailable (bridge requires Node >= 22.5)' };
  }
  const file = dbPath(opts);
  if (!fs.existsSync(file)) {
    return { available: false, reason: `no cortex db at ${file}` };
  }
  let db = null;
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true });
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memories'")
      .get();
    if (!row) return { available: false, reason: `no memories table in ${file}` };
    return { available: true, reason: 'ok' };
  } catch {
    return { available: false, reason: `cannot open cortex db read-only at ${file}` };
  } finally {
    closeQuietly(db);
  }
}

/** Close a DatabaseSync without letting a close error escape. */
function closeQuietly(db) {
  try {
    if (db) db.close();
  } catch {
    // Read-only handle; a failed close leaks nothing worth crashing over.
  }
}

/**
 * Tokenize a recall query into deduplicated lowercase keywords: split on
 * non-alphanumerics, drop tokens shorter than 3 chars and stopwords.
 *
 * @param {string} query
 * @returns {string[]}
 */
function tokenize(query) {
  const tokens = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(tokens)];
}

/** Escape LIKE wildcards (`%`, `_`) and the escape char itself for ESCAPE '\'. */
function escapeLike(token) {
  return token.replace(/[\\%_]/g, '\\$&');
}

/**
 * Build the ranked keyword query: rows matching ANY keyword, scored by how
 * many keywords they match (LIKE is 0/1 in SQLite, so the sum is the hit
 * count), tie-broken by recency.
 *
 * @param {string[]} tokens lowercase keywords
 * @returns {string} parameterized SQL (bind: hit LIKEs, projectId ×2, any-match LIKEs)
 */
function buildQuery(tokens) {
  const like = "content LIKE ? ESCAPE '\\'";
  const hits = tokens.map(() => `(${like})`).join(' + ');
  const anyMatch = tokens.map(() => like).join(' OR ');
  const sql =
    'SELECT id, content, timestamp, created_at, ' +
    `(${hits}) AS hits FROM memories ` +
    `WHERE (project_id = ? OR ? = '') AND (${anyMatch}) ` +
    `ORDER BY hits DESC, timestamp DESC LIMIT ${MAX_RESULTS}`;
  return sql;
}

/** LIKE parameter (`%kw%`, wildcards escaped) for one token. */
function likeParam(token) {
  return `%${escapeLike(token)}%`;
}

/**
 * Map a `memories` row to the provider result shape `cortex-format.formatLine`
 * consumes: `{ id, savedAt, title, body, ageDays }`.
 *
 * @param {{ id: number|string, content: string, timestamp?: string, created_at?: string }} row
 * @returns {{ id: number|string, savedAt: string, title: string, body: string, ageDays: number }}
 */
function toResult(row) {
  const content = String(row.content || '');
  const savedAt = String(row.timestamp || row.created_at || '');
  const firstLine = content.split('\n', 1)[0].trim();
  const title = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
  return { id: row.id, savedAt, title, body: content, ageDays: ageDaysOf(savedAt) };
}

/** Whole days elapsed since `savedAt`; invalid/future timestamps clamp to 0. */
function ageDaysOf(savedAt) {
  const ms = new Date(savedAt).getTime();
  if (!Number.isFinite(ms)) return 0;
  return Math.max(0, Math.floor((Date.now() - ms) / 86400000));
}

/**
 * Keyword+recency recall against the cortex db. Read-only; fail-open: zero
 * usable keywords, a missing db, or any sqlite error → `[]`.
 *
 * @param {string} query free-text recall query
 * @param {string} projectId cortex project id ('' = no project filter)
 * @param {{ home?: string, env?: object }} [opts] db-path resolution overrides
 *
 * SYNCHRONOUS by design: the Phase 2 render pipeline (appendCortexQuery in
 * cortex-hook.js) is synchronous and cannot await — an async recall would
 * feed a Promise into normalizeRecall, render a false "no matches", and burn
 * the once-per-session fire marker. node:sqlite DatabaseSync is fully
 * synchronous, so nothing is lost. (Phase 1's bg worker awaits the return
 * value, which is a no-op for a plain Array.)
 *
 * @returns {Array<{id:number|string,savedAt:string,title:string,body:string,ageDays:number}>}
 */
function recall(query, projectId, opts = {}) {
  let db = null;
  try {
    const sqlite = loadSqlite();
    if (!sqlite) return [];
    const tokens = tokenize(query);
    if (tokens.length === 0) return [];

    db = new sqlite.DatabaseSync(dbPath(opts), { readOnly: true });
    const likes = tokens.map(likeParam);
    const project = String(projectId || '');
    // Param order mirrors buildQuery: hit-count LIKEs, project pair, any-match LIKEs.
    const rows = db.prepare(buildQuery(tokens)).all(...likes, project, project, ...likes);
    return rows.map(toResult);
  } catch {
    return [];
  } finally {
    closeQuietly(db);
  }
}

module.exports = { detect, recall, dbPath, tokenize, escapeLike, MAX_RESULTS };
