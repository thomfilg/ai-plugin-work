'use strict';

/**
 * index.js — runtime selection (design §A) and the Runtime facade.
 *
 * Precedence (probe finding P2: a codex tool shell inherits the launching
 * Claude session's FULL env — CLAUDECODE=1, CLAUDE_CODE_SESSION_ID, even a
 * stale CLAUDE_PLUGIN_ROOT — so Claude env signals must rank LAST):
 *   1. AGENT_RUNTIME env pin (tests, maestro launches, operator)
 *   2. payload sniff: turn_id / rollout transcript_path ⇒ codex;
 *      /.claude/projects/ transcript_path ⇒ claude
 *   3. PLUGIN_ROOT set ⇒ codex (codex-only hook env, ground truth §2.7.1)
 *   4. CODEX_THREAD_ID set ⇒ codex (codex model-shell signature)
 *   5. session stamp (~/.claude/.agent-runtime/<sha1(cwd)>.json, TTL 12h)
 *   6. CLAUDECODE=1 / CLAUDE_CODE_SESSION_ID ⇒ claude
 *   7. default claude — the load-bearing compatibility guarantee.
 *
 * CODEX_HOME / other CODEX_* vars are never used for detection (leak both
 * ways); CODEX_THREAD_ID is the one probe-verified exception.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const emitMod = require('./emit');
const payloadMod = require('./payload');

const VALID_RUNTIMES = new Set(['claude', 'codex']);
const ROLLOUT_PATH_RE = /sessions\/\d{4}\/\d{2}\/\d{2}\/rollout-/;
const STAMP_TTL_MS = 12 * 60 * 60 * 1000;

let warnedInvalidPin = false;

function stampDir() {
  return path.join(os.homedir(), '.claude', '.agent-runtime');
}

function stampPath(cwd) {
  const key = crypto
    .createHash('sha1')
    .update(path.resolve(cwd || process.cwd()))
    .digest('hex');
  return path.join(stampDir(), `${key}.json`);
}

function readStamp(cwd) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stampPath(cwd), 'utf8'));
    if (!parsed || !VALID_RUNTIMES.has(parsed.runtime)) return null;
    if (Date.now() - new Date(parsed.ts).getTime() > STAMP_TTL_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

function sniffPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.turn_id) return 'codex';
  const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
  if (ROLLOUT_PATH_RE.test(transcriptPath)) return 'codex';
  if (transcriptPath.includes('/.claude/projects/')) return 'claude';
  return null;
}

function pinnedRuntime(env) {
  const pinned = env.AGENT_RUNTIME;
  if (!pinned) return null;
  if (VALID_RUNTIMES.has(pinned)) return pinned;
  if (!warnedInvalidPin) {
    warnedInvalidPin = true;
    process.stderr.write(`[runtime] unknown AGENT_RUNTIME="${pinned}" — defaulting to claude\n`);
  }
  return 'claude';
}

/** Pure detection — precedence §A. `env` is injectable for tests. */
function detectRuntime(payload, env = process.env) {
  const pinned = pinnedRuntime(env);
  if (pinned) return pinned;
  const sniffed = sniffPayload(payload);
  if (sniffed) return sniffed;
  if (env.PLUGIN_ROOT) return 'codex';
  if (env.CODEX_THREAD_ID) return 'codex';
  const stamp = readStamp(payload && payload.cwd);
  if (stamp) return stamp.runtime;
  if (env.CLAUDECODE === '1' || env.CLAUDE_CODE_SESSION_ID) return 'claude';
  return 'claude';
}

/**
 * 'interactive' | 'exec' | 'unknown'. Meaningful on codex only (claude is
 * always interactive here): exec mode is the approval-never/bypassPermissions
 * profile (ground truth §6.2). AGENT_RUNTIME_MODE overrides the heuristic.
 */
function resolveMode(name, payload, env = process.env) {
  if (name !== 'codex') return 'interactive';
  const forced = env.AGENT_RUNTIME_MODE;
  if (forced === 'interactive' || forced === 'exec') return forced;
  const permissionMode = payload && payload.permission_mode;
  if (permissionMode === 'bypassPermissions') return 'exec';
  if (typeof permissionMode === 'string' && permissionMode !== '') return 'interactive';
  return 'unknown';
}

function createRuntime(name, payload) {
  return {
    name,
    mode: () => resolveMode(name, payload),
    emit: emitMod.createEmit(name),
    normalizeHookPayload: (raw, opts = {}) =>
      payloadMod.normalizeHookPayload(raw, { ...opts, runtime: name }),
    isSubagentContext: payloadMod.isSubagentContext,
  };
}

let cachedRuntime = null;

/**
 * Memoized Runtime facade. A hook process handles one payload, so the first
 * call decides for the process lifetime (pass the payload on that call).
 */
function getRuntime(payload) {
  if (!cachedRuntime) cachedRuntime = createRuntime(detectRuntime(payload), payload);
  return cachedRuntime;
}

/** Test hook: clear the memoized runtime (and the one-shot pin warning). */
function resetRuntimeCache() {
  cachedRuntime = null;
  warnedInvalidPin = false;
}

/**
 * SessionStart stamp writer (§A.5): persists {runtime, sessionId, ts} keyed
 * by sha1(cwd) so driver CLIs (work-next.js et al.) classify correctly when
 * codex is launched from a Claude terminal. Fail-open — never breaks a
 * session start.
 */
function stampRuntime(payload) {
  try {
    const cwd = (payload && payload.cwd) || process.cwd();
    const stamp = {
      runtime: detectRuntime(payload),
      sessionId: (payload && payload.session_id) || process.env.CLAUDE_CODE_SESSION_ID || null,
      ts: new Date().toISOString(),
    };
    fs.mkdirSync(stampDir(), { recursive: true });
    const file = stampPath(cwd);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(stamp)}\n`);
    fs.renameSync(tmp, file);
  } catch {
    /* fail-open */
  }
}

module.exports = {
  getRuntime,
  detectRuntime,
  sniffPayload,
  stampRuntime,
  resetRuntimeCache,
  readStamp,
  stampPath,
  resolveMode,
};
