'use strict';

/**
 * Cortex auto-recall orchestrator.
 *
 * Composes the foundation libs (config, session-cache, ticket-id, cortex-format)
 * into the lifecycle the synapsys hook drives:
 *   - resolveProjectId / resolveTicketId — identify the project + ticket
 *   - deriveKeywords — build a deterministic, NO-LLM keyword query
 *   - shouldRun — gate on kill-switch + config
 *   - scheduleRecall — fire-and-forget detached background recall (≤2 queries)
 *   - consumeCache — read the background record, format a block, delete the cache
 *
 * Hard constraints: no model-client require anywhere in this file (R16); cortex
 * call budget is bounded at 2 per session (R15); every public method degrades
 * gracefully and never propagates an exception (R14).
 *
 * @module lib/cortex-recall
 */

const path = require('node:path');
const { spawn: defaultSpawn, execFileSync } = require('node:child_process');

const { getCurrentTaskId } = require('./ticket-id');
const cache = require('./session-cache');
const sentinel = require('./consume-sentinel');
const { formatBlock } = require('./cortex-format');

/**
 * Default command runner for the git/gh probes below. Unlike `memory-store`'s
 * `safeExec` (which runs through a shell via `execSync`), this splits the
 * command into an argv array and uses `execFileSync` with NO shell. That closes
 * the CodeQL "shell command built from environment values" / "indirect
 * uncontrolled command line" sinks: a tainted token (e.g. a ticket number
 * interpolated into `gh issue view <N>`) becomes a plain argv element rather
 * than a shell-interpreted word, so it can never be parsed as a command. All
 * call sites here use fixed, space-separated commands with no quoted arguments,
 * so a whitespace split is lossless. Never throws — returns '' on any failure.
 *
 * @param {string} cmd space-separated command, e.g. `git status --porcelain`
 * @param {string} cwd working directory
 * @returns {string} trimmed stdout, or '' on error
 */
function shellFreeExec(cmd, cwd) {
  try {
    const [file, ...args] = String(cmd).split(/\s+/).filter(Boolean);
    if (!file) return '';
    return execFileSync(file, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/** Hard cap on cortex calls per session (R15). */
const MAX_QUERIES = 2;

/** Path to the detached background entry point (Task 7). */
const BG_SCRIPT = path.join(__dirname, '..', 'scripts', 'synapsys-cortex-recall-bg.js');

/**
 * Worktree affix patterns stripped from a cwd basename when falling back to a
 * cwd-derived project id (R2 step c).
 */
const AFFIX_PATTERNS = [/^w-/, /-GH-\d+$/i, /-[A-Z]+-\d+$/];

/** Minimal stopword set for keyword derivation (R4). */
const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'but',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'at',
  'by',
  'from',
  'as',
  'is',
  'are',
  'be',
  'this',
  'that',
  'it',
  'add',
  'fix',
  'update',
  'remove',
  'via',
]);

/**
 * Resolve the project id following the documented precedence (R2):
 *   1. `SYNAPSYS_CORTEX_PROJECT` env override
 *   2. `git remote get-url origin` → strip `.git` → last path segment
 *   3. cwd basename minus worktree affixes (`^w-`, `-GH-\d+$`, `-[A-Z]+-\d+$`)
 *
 * @param {string} cwd working directory
 * @param {{ env?: Record<string,string>, exec?: (cmd:string, cwd:string)=>string }} [opts]
 * @returns {string} the resolved project id
 */
function resolveProjectId(cwd = process.cwd(), opts = {}) {
  const env = opts.env || process.env;
  const exec = opts.exec || shellFreeExec;

  // 1. Explicit override.
  if (env.SYNAPSYS_CORTEX_PROJECT) return env.SYNAPSYS_CORTEX_PROJECT;

  // 2. git remote basename minus `.git`.
  try {
    const url = String(exec('git remote get-url origin', cwd) || '').trim();
    const basename = remoteBasename(url);
    if (basename) return basename;
  } catch {
    // Fall through to cwd-basename derivation.
  }

  // 3. cwd basename minus worktree affixes.
  return stripAffixes(path.basename(cwd));
}

/**
 * Extract `<repo>` from a git remote url, dropping a trailing `.git`.
 *
 * @param {string} url remote url (ssh or https)
 * @returns {string} repo basename, or '' when not derivable
 */
function remoteBasename(url) {
  if (!url) return '';
  const last = url
    .replace(/\.git$/, '')
    .split(/[/:]/)
    .pop();
  return (last || '').trim();
}

/**
 * Strip worktree affixes from a cwd basename (R2 step c).
 *
 * @param {string} basename cwd basename
 * @returns {string} the de-affixed project id
 */
function stripAffixes(basename) {
  let out = basename;
  for (const pattern of AFFIX_PATTERNS) {
    out = out.replace(pattern, '');
  }
  return out;
}

/**
 * Resolve the current ticket id via the synapsys-local resolver (R3).
 *
 * @param {string} [cwd] working directory
 * @param {object} [opts] forwarded to `getCurrentTaskId`
 * @returns {string} a `GH-N` / `PROJ-N` id, or '' when nothing matches
 */
function resolveTicketId(cwd = process.cwd(), opts = {}) {
  return getCurrentTaskId(cwd, opts);
}

/**
 * Tokenize a free-text string into lowercased word tokens.
 *
 * @param {string} text input text
 * @returns {string[]} lowercased alphanumeric tokens
 */
function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Derive the keyword query for a ticket with NO LLM call (R4, R16).
 *
 * Pipeline: title tokens (github `gh issue view` title, else branch tokens)
 * augmented with `git status --porcelain` file-stem tokens; lowercased,
 * stopwords dropped, deduped, capped at `maxKeywords`.
 *
 * @param {{ ticketId?: string, cwd?: string }} subject
 * @param {{ exec?: (cmd:string, cwd:string)=>string, maxKeywords?: number }} [opts]
 * @returns {string[]} the derived keyword tokens
 */
function deriveKeywords({ ticketId, cwd = process.cwd() } = {}, opts = {}) {
  const exec = opts.exec || shellFreeExec;
  const maxKeywords = opts.maxKeywords || 6;

  const titleTokens = ticketTitleTokens(ticketId, cwd, exec);
  const stemTokens = fileStemTokens(cwd, exec);

  return dedupeKeywords([...titleTokens, ...stemTokens], maxKeywords);
}

/**
 * Drop stopwords + duplicates from a token stream, capped at `maxKeywords`.
 *
 * @param {string[]} tokens candidate tokens (already lowercased)
 * @param {number} maxKeywords cap on the returned list length
 * @returns {string[]} the filtered keyword tokens
 */
function dedupeKeywords(tokens, maxKeywords) {
  const seen = new Set();
  const out = [];
  for (const token of tokens) {
    if (!token || STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= maxKeywords) break;
  }
  return out;
}

/**
 * Resolve title tokens for the ticket: prefer the GitHub issue title via
 * `gh issue view`, falling back to current-branch tokens on any failure.
 *
 * @param {string} ticketId e.g. `GH-519`
 * @param {string} cwd working directory
 * @param {(cmd:string, cwd:string)=>string} exec command runner
 * @returns {string[]} title tokens
 */
function ticketTitleTokens(ticketId, cwd, exec) {
  const ghMatch = /GH-(\d+)/i.exec(ticketId || '');
  if (ghMatch) {
    try {
      const raw = exec(`gh issue view ${ghMatch[1]} --json title`, cwd);
      const { title } = JSON.parse(raw);
      const tokens = tokenize(title);
      if (tokens.length) return tokens;
    } catch {
      // Fall through to branch tokens.
    }
  }
  try {
    return tokenize(exec('git branch --show-current', cwd));
  } catch {
    return [];
  }
}

/**
 * Tokenize the file stems of `git status --porcelain` changed paths.
 *
 * @param {string} cwd working directory
 * @param {(cmd:string, cwd:string)=>string} exec command runner
 * @returns {string[]} file-stem tokens
 */
function fileStemTokens(cwd, exec) {
  let status = '';
  try {
    status = exec('git status --porcelain', cwd);
  } catch {
    return [];
  }
  const stems = [];
  for (const line of String(status).split(/\r?\n/)) {
    const file = line.slice(3).trim();
    if (!file) continue;
    const stem = path.basename(file).replace(/\.[^.]+$/, '');
    if (stem) stems.push(stem.toLowerCase());
  }
  return stems;
}

/**
 * Decide whether auto-recall should run (R8/R9).
 *
 * @param {Record<string,string>} env process environment
 * @param {{ enabled?: boolean }} config loaded cortex config
 * @returns {boolean} false under kill-switch or `enabled:false`
 */
function shouldRun(env = {}, config = {}) {
  const killSwitch = String((env && env.SYNAPSYS_CORTEX_AUTO_RECALL) || '').toLowerCase() === 'off';
  if (killSwitch) return false;
  return config.enabled !== false;
}

/**
 * Fire-and-forget background recall (R1, R15). Spawns the detached background
 * entry point with at most two queries. Never throws — a spawn failure
 * degrades to a silent no-op (R14).
 *
 * @param {{ queries: string[], projectId: string, sessionId: string, home?: string, spawn?: Function }} args
 * @returns {boolean} true when a background process was launched, false otherwise
 */
function scheduleRecall({ queries = [], projectId, sessionId, home, spawn } = {}) {
  const launch = spawn || defaultSpawn;
  const bounded = queries.filter(Boolean).slice(0, MAX_QUERIES);
  if (bounded.length === 0) return false;

  const args = buildRecallArgs({ bounded, projectId, sessionId, home });

  try {
    const child = launch(process.execPath, args, {
      detached: true,
      stdio: 'ignore',
    });
    if (child && typeof child.unref === 'function') child.unref();
    return true;
  } catch {
    // Graceful degrade — never propagate (R14).
    return false;
  }
}

/**
 * Build the detached-spawn argv for the background recall script: the script
 * path, the single-value flags, and one repeated `--query` flag per query.
 *
 * @param {{ bounded: string[], projectId?: string, sessionId?: string, home?: string }} args
 * @returns {string[]} the argv passed to `node` */
function buildRecallArgs({ bounded, projectId, sessionId, home }) {
  return [
    BG_SCRIPT,
    '--projectId',
    String(projectId || ''),
    '--sessionId',
    String(sessionId || ''),
    '--home',
    String(home || ''),
    ...bounded.flatMap((q) => ['--query', q]),
  ];
}

/**
 * Consume the background cache for a session: read the record, format the
 * `[cortex:auto-recall]` block, delete the cache file, and set a single-consume
 * sentinel. Returns '' when nothing to consume or when already consumed. Never
 * throws (R14).
 * @param {string} sessionId session identifier
 * @param {{ home: string, config?: { max_age_days?: number, max_chars_per_memory?: number } }} opts
 * @returns {string} the formatted block, or '' when nothing to consume
 */
function consumeCache(sessionId, { home, config = {} } = {}) {
  // Single-consume guard: an already-consumed session drops late cache, no inject.
  if (sentinel.isConsumed(cache, sessionId, home)) {
    sentinel.dropStaleCache(cache, sessionId, home);
    return '';
  }

  let record;
  try {
    record = cache.read(sessionId, { home });
  } catch {
    record = null;
  }
  // Defer the SessionStart `baseline:true` placeholder (GH-519:
  // early-consume-drops-recall): consuming its empty results would inject "no
  // matches" and sentinel-drop the real detached write. Leave it for a later
  // prompt to pick up the real write (which never carries `baseline`).
  if (record && record.baseline === true) return '';
  // Mark consumed at this first real attempt regardless of content so a late
  // background write can't re-inject (GH-519: late-recall-without-sentinel).
  sentinel.markConsumed(cache, sessionId, home);
  if (!record || !Array.isArray(record.queries) || record.queries.length === 0) return '';
  const block = formatRecallBlock(record.queries, config);
  try {
    cache.delete(sessionId, { home });
  } catch {
    // Ignore — best-effort cleanup.
  }
  return block;
}

// Format the `[cortex:auto-recall]` block from cached `{ query, projectId,
// results, ranAt }` records, applying the config age/char/result bounds.
// Returns '' on any failure (R14).
function formatRecallBlock(queries, config) {
  try {
    return formatBlock({
      queries,
      maxAgeDays: config.max_age_days ?? 180,
      maxChars: config.max_chars_per_memory ?? 500,
      maxResults: config.max_results_per_query ?? 5,
    });
  } catch {
    return '';
  }
}

module.exports = {
  resolveProjectId,
  resolveTicketId,
  deriveKeywords,
  shouldRun,
  scheduleRecall,
  consumeCache,
  MAX_QUERIES,
};
