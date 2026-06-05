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

// Whitelist filename characters so an attacker-controlled session_id (or one
// containing path separators / "..") can never make appendFileSync escape
// the telemetry directory. Anything containing characters outside [A-Za-z0-9._-]
// — including '/', '\\', or "..", and leading dots used to hide files — falls
// back to the unknown-session bucket.
const SAFE_SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;

function resolveSessionId(payload) {
  if (!payload || typeof payload.session_id !== 'string' || !payload.session_id) {
    return '_unknown-session';
  }
  const candidate = payload.session_id;
  if (!SAFE_SESSION_ID.test(candidate)) return '_unknown-session';
  if (candidate.startsWith('.') || candidate === '..' || candidate.includes('..')) {
    return '_unknown-session';
  }
  return candidate;
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
      typeof match === 'string' && match.length > MATCH_CAP
        ? match.slice(0, MATCH_CAP)
        : match;
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
  const declared = source
    ? source.filter((s) => typeof s === 'string' && s.length > 0)
    : [];
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

function scanForCitations(memories, responseText) {
  const results = [];
  if (typeof responseText !== 'string' || responseText.length === 0) return results;
  if (!Array.isArray(memories)) return results;

  for (const memory of memories) {
    if (!memory || isDisabled(memory)) continue;
    const matched = findFirstSignal(extractSignals(memory), responseText);
    if (matched !== undefined) {
      const capped = matched.length > MATCH_CAP ? matched.slice(0, MATCH_CAP) : matched;
      results.push({ memory, match: capped });
    }
  }
  return results;
}

module.exports = {
  recordFired,
  recordCited,
  scanForCitations,
  extractSignals,
  resolveSessionId,
  telemetryDir,
  isDisabled,
};
