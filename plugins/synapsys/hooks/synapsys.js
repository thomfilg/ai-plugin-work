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
 */

const fs = require('node:fs');
const path = require('node:path');
const { discoverStores, listMemoriesFromStore } = require(
  path.join(__dirname, '..', 'lib', 'memory-store')
);
const { selectForEvent } = require(path.join(__dirname, '..', 'lib', 'matcher'));
const {
  recordFired,
  recordCited,
  scanForCitations,
  resolveSessionId,
  telemetryDir,
} = require(path.join(__dirname, '..', 'lib', 'telemetry'));

const VALID_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']);
const MAX_INJECT_CHARS = 8000;

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

function formatMemory(m) {
  const header = `[synapsys:${m.store.kind}] ${m.name} — ${m.description || '(no description)'}`;
  if (m.inject === 'full') {
    return `${header}\n\n${m.body.trim()}`;
  }
  return `${header}\n  source: ${m.file}`;
}

const SETUP_REQUIRED_HINT =
  '[synapsys:setup-required] No Synapsys memory store is configured for this repo/worktree.\n\n' +
  'AGENT: As your FIRST action this session, surface this to the user and offer to run `/synapsys:install`. Recommend the kind based on context:\n' +
  '  - If `git worktree list` shows >1 entry → recommend `worktree` (shared across all worktrees of this repo)\n' +
  '  - Otherwise → recommend `local`\n' +
  '  - Mention `global` (per-project, survives worktree deletion) and `shared` (one store reused across ALL projects) as options\n\n' +
  'Do NOT install without asking — present the recommendation via `AskUserQuestion` so the user can confirm or choose differently. If the user declines, set SYNAPSYS_NO_SETUP_HINT=1 to silence this prompt for future sessions.';

function emptyStoreHint(stores) {
  const dirs = stores.map((s) => `${s.kind} (${s.dir})`).join(', ');
  return (
    `[synapsys:empty-store] Memory store(s) ready: ${dirs}. No memories yet.\n\n` +
    'AGENT: Mention this to the user and offer two paths:\n' +
    "  - `/synapsys:crystallize` — import Claude's existing auto-memories (if any exist for this repo)\n" +
    '  - `/synapsys:memorize "<what to remember>"` — add a memory manually\n\n' +
    'Do not auto-run either — let the user pick. If they decline, set SYNAPSYS_NO_SETUP_HINT=1 to silence.'
  );
}

// Returns a hint string when SessionStart fires with no store or no memories.
// Returns null when no hint should be emitted (hint disabled or store + memories present).
function getSessionStartHint(event, stores, memories) {
  if (event !== 'SessionStart') return null;
  if (process.env.SYNAPSYS_NO_SETUP_HINT === '1') return null;
  if (!stores.length) return SETUP_REQUIRED_HINT;
  if (!memories.length) return emptyStoreHint(stores);
  return null;
}

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
  if (typeof payload.transcript_path === 'string') return extractFromTranscript(payload.transcript_path);
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
    // End of list on next top-level key or blank line.
    if (line.trim() === '' || /^[a-zA-Z_][\w]*\s*:/.test(line)) inList = false;
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
    const candidates = memories
      .filter((m) => m && firedNames.has(m.name))
      .map(recoverCiteSignals);
    if (!candidates.length) return;
    const hits = scanForCitations(candidates, responseText);
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
  } catch {
    // fail-open
  }
}

function formatMatchedOutput(matched) {
  const out = matched.map(formatMemory).join('\n\n---\n\n');
  if (out.length <= MAX_INJECT_CHARS) return out;
  return `${out.slice(0, MAX_INJECT_CHARS)}\n\n[synapsys: output truncated at ${MAX_INJECT_CHARS} chars]`;
}

function emitMatched(matched, payload, event) {
  if (!matched.length) return;
  for (const m of matched) {
    try {
      recordFired(m, payload, event);
    } catch {
      // fail-open
    }
  }
  process.stdout.write(formatMatchedOutput(matched));
}

(async () => {
  try {
    const event = process.argv[2];
    if (!VALID_EVENTS.has(event)) process.exit(0);

    const payload = parsePayload(await readStdin());
    const cwd = payload.cwd || process.cwd();
    const stores = discoverStores(cwd);
    const memories = stores.flatMap(listMemoriesFromStore);

    const sessionHint = getSessionStartHint(event, stores, memories);
    if (sessionHint) {
      process.stdout.write(sessionHint);
      process.exit(0);
    }

    const matched = memories.length ? selectForEvent(memories, event, payload) : [];
    emitMatched(matched, payload, event);
    if (event === 'Stop') runCiteScan(payload, memories);

    process.exit(0);
  } catch {
    process.exit(0);
  }
})();
