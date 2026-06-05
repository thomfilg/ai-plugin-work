'use strict';

/**
 * Cite-scan helpers extracted from hooks/synapsys.js to keep that dispatcher
 * under the project's max-lines cap. Every export is fail-open: any internal
 * throw degrades to an empty result, never propagates.
 */

const fs = require('node:fs');
const path = require('node:path');
const { recordCited, scanForCitations, resolveSessionId, telemetryDir } = require('./telemetry');

// Read names of memories with event:"fired" from the session JSONL.
// Fail-open: any error returns an empty Set.
function readFiredMemoryNames(sessionId) {
  const out = new Set();
  try {
    const file = path.join(telemetryDir(), `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) return out;
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj && obj.event === 'fired' && typeof obj.memory === 'string') {
          out.add(obj.memory);
        }
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // fail-open
  }
  return out;
}

// Coerce one transcript JSONL row into assistant text. Supports both:
//   - Claude Code: `{type: 'assistant', message: {content: [{type: 'text', text}]}}`
//   - Legacy:     `{role: 'assistant', content: '<string>'}`
// Returns '' for any other shape so the caller can keep scanning.
function transcriptRowToText(obj) {
  if (!obj) return '';
  if (obj.role === 'assistant' && typeof obj.content === 'string') return obj.content;
  const isAssistantMsg = obj.type === 'assistant' || obj.role === 'assistant';
  if (!isAssistantMsg) return '';
  const content = obj.message && obj.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function extractFromTranscript(transcriptPath) {
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const text = transcriptRowToText(JSON.parse(lines[i]));
        if (text) return text;
      } catch {
        // skip malformed line
      }
    }
  } catch {
    // fail-open
  }
  return '';
}

function extractResponseText(payload) {
  if (!payload) return '';
  // Prefer payload.response only when it's non-empty; an empty string here
  // would otherwise mask a transcript_path with the real assistant output.
  if (typeof payload.response === 'string' && payload.response.length > 0) {
    return payload.response;
  }
  if (typeof payload.transcript_path === 'string')
    return extractFromTranscript(payload.transcript_path);
  return '';
}

// Parse a YAML block-list under `cite_signals:` from raw frontmatter text.
// Returns [] when no list is present.
function parseCiteSignalsList(frontmatterText) {
  const lines = frontmatterText.split(/\r?\n/);
  const found = [];
  let inList = false;
  for (const line of lines) {
    if (/^cite_signals\s*:\s*$/.test(line)) {
      inList = true;
      continue;
    }
    if (!inList) continue;
    const item = line.match(/^\s+-\s+(.+?)\s*$/);
    if (item) {
      found.push(item[1].replace(/^["']|["']$/g, ''));
      continue;
    }
    // Skip blank lines — common YAML formatting puts one between the key
    // and its `- items`. End the list only when a new top-level key appears.
    if (line.trim() === '') continue;
    if (/^[a-zA-Z_][\w]*\s*:/.test(line)) inList = false;
  }
  return found;
}

// Re-parse `cite_signals` from a memory's raw file to recover YAML-list
// frontmatter the simple memory-store parser drops (it only handles
// inline `key: value` lines). Fail-open.
function recoverCiteSignals(memory) {
  try {
    if (!memory || !memory.file) return memory;
    const meta = memory.meta;
    const existing =
      meta && Array.isArray(meta.cite_signals)
        ? meta.cite_signals.filter((s) => typeof s === 'string' && s.length > 0)
        : [];
    if (existing.length > 0) return memory;
    const raw = fs.readFileSync(memory.file, 'utf8');
    const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return memory;
    const found = parseCiteSignalsList(fm[1]);
    if (!found.length) return memory;
    return {
      ...memory,
      citeSignals: found.slice(),
      meta: { ...(meta || {}), cite_signals: found.slice() },
    };
  } catch {
    return memory;
  }
}

// Dedupe scanForCitations hits per memory and emit recordCited; fail-open.
function emitCitations(hits, payload) {
  const seen = new Set();
  for (const hit of hits) {
    if (!hit || !hit.memory || seen.has(hit.memory.name)) continue;
    seen.add(hit.memory.name);
    try {
      recordCited(hit.memory, payload, hit.match);
    } catch {
      // fail-open
    }
  }
}

// Stop-only: scan response text for citations of any previously-fired memory.
// Dedupes via Set so each memory is recorded at most once per Stop.
function runCiteScan(payload, memories) {
  try {
    const responseText = extractResponseText(payload);
    if (!responseText) return;
    const sessionId = resolveSessionId(payload);
    // _unknown-session.jsonl pools writes from every anonymous process across
    // its lifetime, so a Stop here cannot prove a fired memory was actually
    // injected in *this* logical session. The dispatcher runs as a fresh
    // process per event, so pid-based filtering can't link Stop to the
    // earlier fired-process either. Skip the cite scan rather than risk
    // emitting cross-session false-positive `cited` events.
    if (sessionId === '_unknown-session') return;
    const firedNames = readFiredMemoryNames(sessionId);
    if (firedNames.size === 0) return;
    const candidates = memories.filter((m) => m && firedNames.has(m.name)).map(recoverCiteSignals);
    if (!candidates.length) return;
    emitCitations(scanForCitations(candidates, responseText), payload);
  } catch {
    // fail-open
  }
}

module.exports = {
  readFiredMemoryNames,
  transcriptRowToText,
  extractFromTranscript,
  extractResponseText,
  parseCiteSignalsList,
  recoverCiteSignals,
  emitCitations,
  runCiteScan,
};
