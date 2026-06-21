'use strict';

/**
 * synapsys telemetry — per-session JSONL writer + cite scanner.
 *
 * Public API:
 *   - recordFired(memory, payload, reason)
 *   - recordCited(memory, payload, match)
 *   - scanForCitations(memories, responseText) -> [{memory, match}]
 *   - extractSignals(memory) -> string[]
 *   - resolveSessionId(payload) -> string
 *   - telemetryDir() -> string
 *   - isDisabled(memory) -> boolean
 *
 * All disk-touching ops are wrapped in inner try/catch — fail-open.
 * Restricted to node:fs, node:path, node:os.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const sharedSessionId = require('./session-id');

const PROCESS_START_MS = Date.now();
const MATCH_CAP = 200;

function telemetryDir() {
  return path.join(os.homedir(), '.claude', 'synapsys', '.telemetry');
}

function isDisabled(memory) {
  if (process.env.SYNAPSYS_TELEMETRY === '0') return true;
  if (!memory) return false;
  // Read top-level normalized field (preferred — memory-store sets this) and
  // fall back to raw meta for memories constructed without normalization.
  if (memory.telemetry === false) return true;
  if (memory.meta && memory.meta.telemetry === false) return true;
  return false;
}

function resolveSessionId(payload) {
  // Both legs go through the shared resolver so inject-ledger and telemetry
  // always produce the SAME id for the same input. Env-var first (GH-583),
  // then payload — both legs apply SAFE_ID_RE (no dot) and sha256-hash unsafe
  // values via hashId, so an id like "sess.v1" becomes the same hashed value
  // in both modules instead of diverging on the regex.
  const fromEnv = sharedSessionId.resolveFromEnv();
  if (fromEnv) return fromEnv;
  const fromPayload = sharedSessionId.resolveFromPayload(payload);
  if (fromPayload) return fromPayload;
  return '_unknown-session';
}

function unknownSessionToken() {
  return `${process.pid}-${PROCESS_START_MS}`;
}

function ensureDir() {
  try {
    const dir = telemetryDir();
    fs.mkdirSync(dir, { recursive: true });
    // Atomic create-if-missing: avoids the TOCTOU window between existsSync
    // and writeFileSync. EEXIST on concurrent first-write is the desired
    // "already there" outcome — swallow it.
    try {
      fs.writeFileSync(path.join(dir, '.gitignore'), '*\n', { flag: 'wx' });
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
    }
    return dir;
  } catch {
    return undefined;
  }
}

function sessionFilePath(sessionId) {
  return path.join(telemetryDir(), `${sessionId}.jsonl`);
}

function writeLine(sessionId, record) {
  try {
    const dir = ensureDir();
    if (!dir) return;
    const file = sessionFilePath(sessionId);
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  } catch {
    // fail-open
  }
}

function recordFired(memory, payload, reason) {
  try {
    if (!memory || isDisabled(memory)) return;
    const sessionId = resolveSessionId(payload);
    let finalReason = reason;
    if (sessionId === '_unknown-session') {
      const token = unknownSessionToken();
      finalReason = reason ? `${reason} ${token}` : token;
    }
    const record = {
      ts: new Date().toISOString(),
      memory: memory.name,
      event: 'fired',
      reason: finalReason,
    };
    writeLine(sessionId, record);
  } catch {
    // fail-open
  }
}

function recordCited(memory, payload, match) {
  try {
    if (!memory || isDisabled(memory)) return;
    const sessionId = resolveSessionId(payload);
    const cappedMatch =
      typeof match === 'string' && match.length > MATCH_CAP ? match.slice(0, MATCH_CAP) : match;
    const record = {
      ts: new Date().toISOString(),
      memory: memory.name,
      event: 'cited',
      match: cappedMatch,
    };
    writeLine(sessionId, record);
  } catch {
    // fail-open
  }
}

/**
 * Strip fenced code blocks from a markdown body so we don't auto-extract
 * identifiers from inside them.
 */
function stripFences(body) {
  if (typeof body !== 'string') return '';
  return body.replace(/```[\s\S]*?```/g, '');
}

function extractAuto(memory) {
  // Callers (extractSignals) guarantee `memory` is truthy.
  const out = new Set();
  if (typeof memory.name === 'string' && memory.name.length > 0) {
    out.add(memory.name);
  }
  const body = typeof memory.body === 'string' ? memory.body : '';
  const stripped = stripFences(body);

  // First H2/H3 heading text (≥ 4 chars).
  const headingMatch = stripped.match(/^[ \t]*#{2,3}[ \t]+(.+?)[ \t]*$/m);
  if (headingMatch) {
    const headingText = headingMatch[1].trim();
    if (headingText.length >= 4) out.add(headingText);
  }

  // Backticked identifiers: single-backticked, ≥ 2 chars, no newlines.
  const ident = /`([^`\n]{2,})`/g;
  let m;
  while ((m = ident.exec(stripped)) !== null) {
    out.add(m[1]);
  }

  return Array.from(out);
}

function extractSignals(memory) {
  if (!memory) return [];
  // Prefer the top-level normalized `citeSignals` array (memory-store coerces
  // both scalar and list YAML forms here). Fall back to raw `meta.cite_signals`
  // for memories that bypass the normalizer.
  const source = Array.isArray(memory.citeSignals)
    ? memory.citeSignals
    : Array.isArray(memory.meta && memory.meta.cite_signals)
      ? memory.meta.cite_signals
      : null;
  const declared = source ? source.filter((s) => typeof s === 'string' && s.length > 0) : [];
  if (declared.length > 0) return declared.slice();
  return extractAuto(memory);
}

function findFirstSignal(signals, responseText) {
  for (const sig of signals) {
    if (typeof sig !== 'string' || sig.length === 0) continue;
    if (responseText.includes(sig)) return sig;
  }
  return undefined;
}

/**
 * Generic signal-list scanner shared by cite + behavior paths.
 * Returns [{memory, signal}] entries — one per memory whose getSignals(memory)
 * list contains a substring of responseText. Skips disabled memories and
 * memories whose getSignals returns a non-array. Signals are capped at
 * MATCH_CAP characters (parallel to scanForCitations behavior).
 */
function matchMemorySignal(memory, responseText, getSignals) {
  if (!memory || isDisabled(memory)) return undefined;
  let signals;
  try {
    signals = getSignals(memory);
  } catch {
    return undefined;
  }
  if (!Array.isArray(signals) || signals.length === 0) return undefined;
  const matched = findFirstSignal(signals, responseText);
  if (matched === undefined) return undefined;
  return matched.length > MATCH_CAP ? matched.slice(0, MATCH_CAP) : matched;
}

function scanForSignalList(memories, responseText, getSignals) {
  const results = [];
  if (typeof responseText !== 'string' || responseText.length === 0) return results;
  if (!Array.isArray(memories)) return results;
  if (typeof getSignals !== 'function') return results;

  for (const memory of memories) {
    const capped = matchMemorySignal(memory, responseText, getSignals);
    if (capped !== undefined) results.push({ memory, signal: capped });
  }
  return results;
}

function scanForCitations(memories, responseText) {
  // Delegate to the shared scanner, then re-shape `{signal}` → `{match}` to
  // preserve the existing public contract for cite callers.
  const hits = scanForSignalList(memories, responseText, (memory) => extractSignals(memory));
  return hits.map(({ memory, signal }) => ({ memory, match: signal }));
}

function recordBehaviorChanged(memory, payload, opts) {
  try {
    if (!memory || isDisabled(memory)) return;
    const sessionId = resolveSessionId(payload);
    const reason = opts && typeof opts.reason === 'string' ? opts.reason : '';
    const rawEvidence = opts && typeof opts.evidence === 'string' ? opts.evidence : '';
    const evidence = rawEvidence.length > MATCH_CAP ? rawEvidence.slice(0, MATCH_CAP) : rawEvidence;
    const record = {
      ts: new Date().toISOString(),
      memory: memory.name,
      event: 'behavior_changed',
      reason,
      evidence,
    };
    writeLine(sessionId, record);
  } catch {
    // fail-open
  }
}

module.exports = {
  recordFired,
  recordCited,
  recordBehaviorChanged,
  scanForCitations,
  scanForSignalList,
  extractSignals,
  resolveSessionId,
  telemetryDir,
  isDisabled,
};
