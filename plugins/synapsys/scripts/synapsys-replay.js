#!/usr/bin/env node
'use strict';

/**
 * synapsys-replay — replay recent Claude Code transcripts against the
 * runtime trigger matcher to surface noisy / mis-tuned synapsys memories.
 *
 * Task 1 (GH-444) — CLI shell + flag parser only.
 * Subsequent tasks wire in the walker, matcher integration, judge, and
 * report renderers. Sibling-owned files (matcher.js, synapsys-explain.js,
 * GH-443) are NOT imported here yet.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeFlag } = require('../lib/cli-args');
const matcher = require('../lib/matcher');
const memoryStore = require('../lib/memory-store');

/**
 * Pure flag parser — no I/O, no process exits. Tests call this directly
 * with a synthetic argv array. The main() entrypoint is responsible for
 * validation + side effects.
 *
 * Recognised R10 flags (all optional):
 *   --since=<Nd>        transcript window (default '7d')
 *   --project=<hash>    restrict to a single ~/.claude/projects/<hash>
 *   --no-judge          skip LLM judge calls; produce null relevance
 *   --json              emit machine-readable JSON to stdout
 *   --only=<csv>        comma-separated memory-name filter
 *   --store=<name|path> store selector (auto-detect like synapsys-explain)
 *   --max-judges=<N>    hard cap on judge API calls (default 200)
 */
function parseFlags(argv) {
  const flag = makeFlag(argv);
  const sinceRaw = flag('since');
  const maxJudgesRaw = flag('max-judges');
  return {
    // Window string ('7d', '14d', ...); parsed into ms by walkTranscripts (Task 3).
    since: sinceRaw === undefined || sinceRaw === true ? '7d' : sinceRaw,
    // Optional project-hash filter; undefined → iterate every project (spec §Decision).
    project: typeof flag('project') === 'string' ? flag('project') : undefined,
    // Skip judge entirely; required when ANTHROPIC_API_KEY is absent.
    noJudge: flag('no-judge') === true,
    // Emit JSON to stdout instead of human-readable report.
    json: flag('json') === true,
    // Memory-name allow-list (comma-separated); applied at memory-load.
    only: typeof flag('only') === 'string' ? flag('only') : undefined,
    // Store selector — name or filesystem path; auto-detect like explain.
    store: typeof flag('store') === 'string' ? flag('store') : undefined,
    // Hard upper bound on judge API calls; over-cap triggers even sampling.
    maxJudges: maxJudgesRaw === undefined || maxJudgesRaw === true ? 200 : Number(maxJudgesRaw),
    // Test-only override (Task 8): direct ~/.claude/projects/ to a tmp dir.
    transcriptsBase:
      typeof flag('transcripts-base') === 'string' ? flag('transcripts-base') : undefined,
  };
}

/**
 * Print message to stderr and exit with the given code. Default code 2 per
 * spec §CLI: exit 2 on misconfig (unknown --store, invalid --since/--project).
 */
function die(msg, code = 2) {
  process.stderr.write(`synapsys-replay: ${msg}\n`);
  process.exit(code);
}

/**
 * Centralised judge gate (Task 8 REFACTOR target — exported for tests if
 * needed later). Returns true only when judging is allowed AND warranted:
 *   - `--no-judge` not set
 *   - `ANTHROPIC_API_KEY` present
 *   - at least one UPS fire to judge (PTU is not judged in v1, spec §Decision)
 */
function shouldJudge({ noJudge, apiKey, upsFires }) {
  if (noJudge) return false;
  if (!apiKey) return false;
  if (!upsFires || upsFires <= 0) return false;
  return true;
}

/**
 * Wired main() (Task 8). Pipeline:
 *   parseFlags → validate → loadStore → loadMemories (apply --only)
 *   → walkTranscripts → iterLines → extractEvents → replayEvent
 *   → (optional) judgePipeline → aggregateReport → suggestTightening
 *   → renderReport / renderJson → exit
 *
 * Validation precedes I/O so `--since`/`--store` misconfigs exit 2 before
 * any filesystem or network touches (spec §CLI). No-transcripts window is
 * handled before the judge step and prints a friendly message (R12 / G10).
 * Missing `ANTHROPIC_API_KEY` without `--no-judge` emits a single stderr
 * notice and proceeds as `--no-judge` (spec §Security / AC5).
 */
async function main(argv) {
  const flags = parseFlags(argv);

  // Validation (BEFORE any I/O — spec §CLI exit 2).
  if (!/^\d+d$/.test(flags.since)) {
    die(`invalid --since=${flags.since} (expected format like 7d, 14d)`);
  }
  if (flags.project !== undefined && !/^[\w.-]+$/.test(flags.project)) {
    die(`invalid --project=${flags.project}`);
  }

  // Resolve store(s) and load memories. loadStore may die() on unknown store.
  const stores = loadStore({ storeFlag: flags.store, cwd: process.cwd() });
  let memories = loadMemories(stores);
  if (flags.only) {
    const allow = new Set(
      flags.only
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    memories = memories.filter((m) => allow.has(m.name));
  }

  // Walk transcripts. Honor --transcripts-base override for hermetic tests.
  const files = walkTranscripts({
    since: flags.since,
    project: flags.project,
    baseDir: flags.transcriptsBase,
  });

  // R12 / G10 — no-transcripts case: friendly stdout, clean stderr, exit 0.
  if (files.length === 0) {
    process.stdout.write('no transcripts in window\n');
    process.exit(0);
  }

  // Stream events through the matcher.
  const tuples = [];
  let eventsTotal = 0;
  let eventsUps = 0;
  let eventsPtu = 0;
  for (const file of files) {
    for (const parsed of iterLines(file)) {
      const events = extractEvents(parsed);
      for (const ev of events) {
        eventsTotal += 1;
        if (ev.event === 'UserPromptSubmit') eventsUps += 1;
        else if (ev.event === 'PreToolUse') eventsPtu += 1;
        const evTuples = replayEvent(memories, ev);
        for (const t of evTuples) {
          // Preserve prompt text on fires for judge prompt construction.
          if (t.fired && ev.event === 'UserPromptSubmit') t.prompt = ev.prompt;
          tuples.push(t);
        }
      }
    }
  }

  // Judge decision. Missing key + !noJudge → stderr notice + treat as no-judge.
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  const upsFires = tuples.filter((t) => t.fired && t.event === 'UserPromptSubmit').length;
  if (!flags.noJudge && !apiKey) {
    process.stderr.write('synapsys-replay: ANTHROPIC_API_KEY not set; proceeding as --no-judge\n');
  }
  const judging = shouldJudge({ noJudge: flags.noJudge, apiKey, upsFires });

  let judgments;
  let judgeCalls = 0;
  let extrapolated = false;
  if (judging) {
    const items = tuples
      .filter((t) => t.fired && t.event === 'UserPromptSubmit')
      .map((t) => ({ memory: t.memory_name, prompt: t.prompt, matched: t.matched_substring }));
    const pipeline = await judgePipeline(items, {
      apiKey,
      model: 'claude-haiku-4-5',
      maxJudges: flags.maxJudges,
    });
    extrapolated = pipeline.extrapolated;
    judgeCalls = Math.ceil(pipeline.results.length / JUDGE_BATCH_SIZE);
    judgments = {};
    for (const r of pipeline.results) {
      if (!judgments[r.memory]) {
        judgments[r.memory] = { relevant: 0, irrelevant: 0, judge_failed: 0 };
      }
      if (r.judge_failed) judgments[r.memory].judge_failed += 1;
      else if (r.relevant === true) judgments[r.memory].relevant += 1;
      else if (r.relevant === false) judgments[r.memory].irrelevant += 1;
    }
  }

  // Aggregate + suggest.
  const agg = aggregateReport(tuples, judgments);
  // When the judge did not run, every memory's relevance is unknown — null
  // out the bookkeeping fields so the JSON / report communicate that clearly
  // (AC5 / R4). aggregateReport itself stays test-stable for Task 5.
  if (!judging) {
    for (const name of Object.keys(agg)) {
      agg[name].relevant = null;
      agg[name].irrelevant = null;
      agg[name].fp_rate = null;
    }
  }
  const suggestions = [];
  for (const memory of memories) {
    const sug = suggestTightening(memory, agg[memory.name]);
    if (sug) suggestions.push(sug);
  }

  // Render.
  const meta = {
    store: stores.map((s) => s.dir).join(','),
    window: flags.since,
    events_total: eventsTotal,
    events_ups: eventsUps,
    events_ptu: eventsPtu,
    judgeCalls,
    extrapolated,
  };
  if (flags.json) {
    process.stdout.write(renderJson(agg, suggestions, meta) + '\n');
  } else {
    process.stdout.write(renderReport(agg, suggestions, meta));
  }
  process.exit(0);
}

/**
 * Pure transcript → synthetic-event mapper (Task 2, R2, G1+G2).
 *
 * Claude Code records each turn as a JSONL entry. We synthesize the same
 * event payloads the runtime trigger matcher consumes:
 *
 *   - `type=user`        → `{event:'UserPromptSubmit', prompt}`
 *     `message.content` is either a plain string or an array of content
 *     blocks (we concatenate `type=text` blocks' `text` fields).
 *
 *   - `type=assistant`   → one `{event:'PreToolUse', tool, tool_input}`
 *     per `tool_use` content block (the assistant may emit multiple tool
 *     calls per turn; each becomes its own PTU event).
 *
 *   - anything else (system, summary, malformed) → `[]`
 *
 * Pure function: no I/O, no globals. Inputs and outputs are plain data.
 */
function extractEvents(parsedLine) {
  if (!parsedLine || typeof parsedLine !== 'object') return [];
  const { type, message } = parsedLine;

  if (type === 'user') {
    if (!message || message.content === undefined || message.content === null) return [];
    const content = message.content;
    if (typeof content === 'string') {
      return [{ event: 'UserPromptSubmit', prompt: content }];
    }
    if (Array.isArray(content)) {
      const prompt = content
        .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('');
      if (prompt.length === 0) return [];
      return [{ event: 'UserPromptSubmit', prompt }];
    }
    return [];
  }

  if (type === 'assistant') {
    if (!message || !Array.isArray(message.content)) return [];
    return message.content
      .filter((b) => b && b.type === 'tool_use' && typeof b.name === 'string')
      .map((b) => ({
        event: 'PreToolUse',
        tool: b.name,
        tool_input: b.input,
      }));
  }

  return [];
}

/**
 * Convert a `--since=Nd` window string into milliseconds.
 *
 * Task 3 (R1). Throws on invalid format; main()/die() handles user-facing
 * error reporting per spec §CLI (exit code 2 on misconfig).
 */
function parseSince(spec) {
  if (typeof spec !== 'string' || !/^\d+d$/.test(spec)) {
    throw new Error(`invalid --since=${spec} (expected format like 7d, 14d)`);
  }
  const days = Number(spec.slice(0, -1));
  return days * 24 * 60 * 60 * 1000;
}

/**
 * Walk `*.jsonl` transcripts under `baseDir` (default `~/.claude/projects/`)
 * whose mtime falls within the `--since` window. When `project` is provided,
 * only that hash-dir is searched. Missing/empty directories return `[]`
 * (R12 walker-level no-transcripts detection).
 *
 * Injectable `baseDir` keeps tests off the real `~/.claude/projects/` and
 * avoids fs monkey-patching.
 */
function walkTranscripts({ since, project, baseDir } = {}) {
  const root = baseDir || path.join(os.homedir(), '.claude/projects');
  if (!fs.existsSync(root)) return [];
  const windowMs = parseSince(since || '7d');
  const cutoff = Date.now() - windowMs;

  let projectDirs;
  if (project) {
    const dir = path.join(root, project);
    if (!fs.existsSync(dir)) return [];
    projectDirs = [dir];
  } else {
    projectDirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  }

  const out = [];
  for (const projDir of projectDirs) {
    let entries;
    try {
      entries = fs.readdirSync(projDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const full = path.join(projDir, entry.name);
      let stat;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      if (stat.mtimeMs >= cutoff) out.push(full);
    }
  }
  return out;
}

/**
 * Stream-parse a JSONL transcript file. Yields one parsed object per
 * non-empty line; malformed lines emit a single stderr warning and are
 * skipped (R1). Returned as an iterable array — the file is read
 * synchronously since transcripts are bounded and small per spec §Perf.
 */
function* iterLines(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    process.stderr.write(`synapsys-replay: cannot read ${filePath}: ${err.message}\n`);
    return;
  }
  const lines = raw.split('\n');
  for (const line of lines) {
    if (line.length === 0) continue;
    try {
      yield JSON.parse(line);
    } catch (err) {
      process.stderr.write(
        `synapsys-replay: malformed JSONL line in ${filePath} (skipped): ${err.message}\n`
      );
    }
  }
}

/**
 * Replay a synthetic event against every memory and return one tuple per
 * memory: `{memory_name, event, fired, matched_substring}`. Task 4 (R3, G3).
 *
 * Dispatch:
 *   - `event.event === 'UserPromptSubmit'` → `matcher.matchPrompt(memory, event.prompt)`
 *   - `event.event === 'PreToolUse'`       → `matcher.matchPreTool(memory, {tool_name, tool_input})`
 *
 * Per GH-443 `MatchResult` schema, on fire the matcher returns
 * `{fired: true, matched: {...}}`. Consumed fields for `matched_substring`:
 *   - `matched.prompt_substring`  (UPS, see matcher.matchPrompt)
 *   - `matched.content_substring` (PTU with content patterns, see matcher.matchPreTool)
 * Other `matched` fields (`prompt_token`, `pretool_pattern`, `content_pattern`,
 * `negative_pattern`) are NOT consumed by replay; they are used by explain/R16.
 */
function replayEvent(memories, event) {
  const out = [];
  for (const memory of memories) {
    const result = dispatchMatch(memory, event);
    const matched = result && result.matched ? result.matched : undefined;
    const matched_substring = matched
      ? matched.prompt_substring !== undefined
        ? matched.prompt_substring
        : matched.content_substring
      : undefined;
    out.push({
      memory_name: memory.name,
      event: event.event,
      fired: Boolean(result && result.fired),
      matched_substring,
    });
  }
  return out;
}

function dispatchMatch(memory, event) {
  if (event.event === 'UserPromptSubmit') {
    return matcher.matchPrompt(memory, event.prompt || '');
  }
  if (event.event === 'PreToolUse') {
    return matcher.matchPreTool(memory, {
      tool_name: event.tool,
      tool_input: event.tool_input,
    });
  }
  return { fired: false, reason: 'events-exclude' };
}

/**
 * Resolve `--store` flag against `discoverStores(cwd)` (memory-store.js).
 * Mirrors the selector logic in scripts/synapsys-explain.js (sibling-owned,
 * GH-443) — we re-derive locally rather than importing to keep the script
 * boundary clean.
 *
 *   - storeFlag undefined/empty → return every discovered store
 *   - storeFlag matches a `kind` (local/worktree/global/shared) → filter
 *   - storeFlag is a path → resolve absolute and match by dir
 *   - no match → die() exit 2 (spec §CLI)
 */
function loadStore({ storeFlag, cwd } = {}) {
  const resolvedCwd = cwd || process.cwd();
  const stores = memoryStore.discoverStores(resolvedCwd);
  if (!storeFlag || storeFlag === true) return stores;
  const byKind = stores.filter((s) => s.kind === storeFlag);
  if (byKind.length) return byKind;
  const abs = path.resolve(storeFlag);
  const byPath = stores.filter((s) => path.resolve(s.dir) === abs);
  if (byPath.length) return byPath;
  // Path-form fallback: if the absolute path carries the store marker, accept
  // it even when it lives outside discoverStores() reach. Lets callers point
  // at a hermetic test store under /tmp (Task 8 fixtures).
  if (fs.existsSync(path.join(abs, '.synapsys.json'))) {
    return [{ kind: 'path', dir: abs, projectName: path.basename(abs) }];
  }
  die(`unknown --store "${storeFlag}" (no matching discovered store)`, 2);
}

/**
 * Load all memories from a list of discovered stores by delegating to
 * memory-store.listMemoriesFromStore (single source of truth for frontmatter
 * parsing — never re-implemented here).
 */
function loadMemories(stores) {
  const all = [];
  for (const s of stores) {
    all.push(...memoryStore.listMemoriesFromStore(s));
  }
  return all;
}

/**
 * Split `trigger_prompt` on top-level `|` only (outside `(...)` / `[...]`).
 * Used by suggestTightening to inspect alternation arms for heuristic R8.
 * Vendored locally per spec §Arch — not exported from matcher.
 */
function splitTopLevelAlternation(triggerPrompt) {
  if (typeof triggerPrompt !== 'string' || triggerPrompt.length === 0) return [];
  const arms = [];
  let depthParen = 0;
  let depthBracket = 0;
  let buf = '';
  for (let i = 0; i < triggerPrompt.length; i++) {
    const ch = triggerPrompt[i];
    if (ch === '(') depthParen++;
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1);
    else if (ch === '[') depthBracket++;
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1);
    if (ch === '|' && depthParen === 0 && depthBracket === 0) {
      arms.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  arms.push(buf);
  return arms;
}

/**
 * fp_rate = 1 - relevant / (relevant + irrelevant). judge_failed excluded.
 */
function fpRate(relevant, irrelevant) {
  const denom = relevant + irrelevant;
  if (denom <= 0) return null;
  return 1 - relevant / denom;
}

/**
 * Aggregate per-memory metrics from replay tuples + judge results.
 *
 * `tuples` — output of replayEvent across the event stream:
 *   `{memory_name, event, fired, matched_substring}`
 * `judgments` — keyed by memory_name (UPS memories only):
 *   `{relevant, irrelevant, judge_failed}` counts
 *
 * Returns object keyed by memory_name:
 *   `{fires, relevant, irrelevant, judge_failed, fp_rate, sample_matches}`
 *
 * PTU-only memories (any fired tuple has event PreToolUse and no UPS fires)
 * report `relevant=null` / `fp_rate=null` (spec §Decision — PTU not judged v1).
 * `sample_matches` is the top-3 most-frequent distinct matched substrings.
 */
function aggregateReport(tuples, judgments) {
  const report = {};
  const fireBuckets = {};
  for (const t of tuples) {
    if (!report[t.memory_name]) {
      report[t.memory_name] = {
        fires: 0,
        relevant: 0,
        irrelevant: 0,
        judge_failed: 0,
        fp_rate: null,
        sample_matches: [],
        _hasUps: false,
        _hasPtu: false,
      };
      fireBuckets[t.memory_name] = { events: new Set(), subs: new Map() };
    }
    if (t.fired) {
      report[t.memory_name].fires += 1;
      fireBuckets[t.memory_name].events.add(t.event);
      if (t.event === 'UserPromptSubmit') report[t.memory_name]._hasUps = true;
      if (t.event === 'PreToolUse') report[t.memory_name]._hasPtu = true;
      if (t.matched_substring) {
        const m = fireBuckets[t.memory_name].subs;
        m.set(t.matched_substring, (m.get(t.matched_substring) || 0) + 1);
      }
    }
  }
  for (const name of Object.keys(report)) {
    const entry = report[name];
    const j = judgments && judgments[name];
    if (j && entry._hasUps) {
      entry.relevant = j.relevant || 0;
      entry.irrelevant = j.irrelevant || 0;
      entry.judge_failed = j.judge_failed || 0;
      entry.fp_rate = fpRate(entry.relevant, entry.irrelevant);
    } else if (!entry._hasUps && entry._hasPtu) {
      // PTU-only memory: not judged in v1.
      entry.relevant = null;
      entry.irrelevant = null;
      entry.fp_rate = null;
    }
    // Top-3 most-frequent distinct substrings (deterministic: count desc,
    // then lexical asc).
    const subs = fireBuckets[name].subs;
    entry.sample_matches = Array.from(subs.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3)
      .map(([s]) => s);
    delete entry._hasUps;
    delete entry._hasPtu;
  }
  return report;
}

/**
 * Heuristic R8 — emit advisory when `fp_rate > 0.70` AND `trigger_prompt`
 * contains short (<5 chars) single-word alternation arms. Returns
 * `{memory, candidates}` or `null`. Never auto-applied.
 */
function suggestTightening(memory, agg) {
  if (!memory || !agg) return null;
  if (agg.fp_rate === null || agg.fp_rate === undefined) return null;
  if (!(agg.fp_rate > 0.7)) return null;
  const arms = splitTopLevelAlternation(memory.triggerPrompt || '');
  const candidates = arms.filter((a) => {
    const trimmed = a.trim();
    // Spec R8 — "short" arm. Task 5 example (`push|fetch|deploy-production` →
    // `[push,fetch]`) treats 5-char single-word arms as short, so the bound is
    // inclusive: length <= 5 with `_`/`-`/alnum chars only (single word).
    return trimmed.length > 0 && trimmed.length <= 5 && /^[A-Za-z0-9_-]+$/.test(trimmed);
  });
  if (candidates.length === 0) return null;
  return { memory: memory.name, candidates };
}

/**
 * Render the aggregated report as machine-readable JSON (R9, G6).
 *
 * Stable top-level key order: `memories`, `suggestions`, `events_total`,
 * `events_ups`, `events_ptu`. Each `memories[i]` has keys (in order):
 * `name`, `fires`, `relevant`, `irrelevant`, `judge_failed`, `fp_rate`,
 * `sample_matches`.
 *
 * Spec §Security — `ANTHROPIC_API_KEY` is never included in output; this
 * function only serialises the inputs it is handed (no env access).
 */
function renderJson(agg, suggestions, meta) {
  const memories = Object.keys(agg).map((name) => {
    const m = agg[name];
    // Explicit key ordering for determinism.
    return {
      name,
      fires: m.fires,
      relevant: m.relevant,
      irrelevant: m.irrelevant,
      judge_failed: m.judge_failed,
      fp_rate: m.fp_rate,
      sample_matches: m.sample_matches,
    };
  });
  const payload = {
    memories,
    suggestions: Array.isArray(suggestions) ? suggestions : [],
    events_total: meta && typeof meta.events_total === 'number' ? meta.events_total : 0,
    events_ups: meta && typeof meta.events_ups === 'number' ? meta.events_ups : 0,
    events_ptu: meta && typeof meta.events_ptu === 'number' ? meta.events_ptu : 0,
  };
  return JSON.stringify(payload, null, 2);
}

// Cost model constants (R17): ~500 input + 5 output tokens per judge call.
// Haiku pricing approx $1.00 / 1M input + $5.00 / 1M output tokens.
const PRICE_PER_TOKEN = 1e-6; // ~$1/1M as a conservative per-token blend.
const TOKENS_PER_JUDGE_CALL = 500 + 5;

/**
 * Render the human-readable report (R11). Includes:
 *   - header: `store=... window=... events=... UPS=... PTU=...`
 *   - per-memory table rows
 *   - `Suggestions:` section
 *   - cost footer when `meta.judgeCalls > 0` (R17)
 */
function renderReport(agg, suggestions, meta) {
  const lines = [];
  const m = meta || {};
  lines.push(
    `store=${m.store || ''} window=${m.window || ''} events=${m.events_total || 0} ` +
      `UPS=${m.events_ups || 0} PTU=${m.events_ptu || 0}`
  );
  lines.push('');
  lines.push(
    'Memory'.padEnd(30) +
      'Fires'.padStart(7) +
      'Relevant'.padStart(10) +
      'FP%'.padStart(8) +
      '  Sample matches'
  );
  for (const name of Object.keys(agg)) {
    const e = agg[name];
    const relevant = e.relevant === null || e.relevant === undefined ? '—' : String(e.relevant);
    const fpPct =
      e.fp_rate === null || e.fp_rate === undefined ? '—' : `${Math.round(e.fp_rate * 100)}%`;
    const samples = (e.sample_matches || []).slice(0, 3).join(', ');
    lines.push(
      name.padEnd(30) +
        String(e.fires).padStart(7) +
        relevant.padStart(10) +
        fpPct.padStart(8) +
        '  ' +
        samples
    );
  }
  lines.push('');
  lines.push('Suggestions:');
  const sugs = Array.isArray(suggestions) ? suggestions : [];
  if (sugs.length === 0) {
    lines.push('  (none)');
  } else {
    for (const s of sugs) {
      lines.push(`  - ${s.memory}: tighten short arms [${(s.candidates || []).join(', ')}]`);
    }
  }
  if (m.judgeCalls && m.judgeCalls > 0) {
    const cost = TOKENS_PER_JUDGE_CALL * m.judgeCalls * PRICE_PER_TOKEN;
    lines.push('');
    lines.push(`est. cost ≈ $${cost.toFixed(4)} (${m.judgeCalls} judge calls)`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Task 7 — judge HTTP integration.
 *
 * `judgeBatch(items, {fetchImpl, apiKey, model})` POSTs a single batch (≤10
 * items per R18) to Anthropic Messages API, parses positional `N: yes/no`
 * replies, and returns per-item `{relevant}` or `{judge_failed:true}`
 * outcomes. Never throws on network/HTTP errors; never leaks `apiKey`
 * into thrown error messages.
 */
const ANTHROPIC_MESSAGES_URL = 'https://api.anthropic.com/v1/messages';
const JUDGE_BATCH_SIZE = 10; // R18
const REPLY_LINE_REGEX = /^\s*(\d+)\s*:\s*(yes|no)\b/i;

async function judgeBatch(items, { fetchImpl, apiKey, model } = {}) {
  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) {
    return items.map(() => ({ judge_failed: true, error: 'no fetch impl' }));
  }
  const numbered = items
    .map(
      (it, i) =>
        `${i + 1}) memory=${it.memory} prompt=${JSON.stringify(it.prompt)} matched=${JSON.stringify(it.matched)}`
    )
    .join('\n');
  const body = JSON.stringify({
    model,
    max_tokens: 256,
    system:
      'You are a relevance judge for synapsys memories. For each numbered item, decide whether the memory was ACTUALLY RELEVANT to the user prompt shown. Reply with one line per item in the exact form "N: yes" or "N: no" (lowercase, no extra text). Answer "yes" only when the memory would have been useful context for that prompt; otherwise "no". Do not add explanations or any other output.',
    messages: [{ role: 'user', content: numbered }],
  });
  let resp;
  try {
    resp = await doFetch(ANTHROPIC_MESSAGES_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body,
    });
  } catch (err) {
    // Network failure → all items judge-failed; do NOT include apiKey in error.
    const safe = String(err && err.message ? err.message : err);
    return items.map(() => ({ judge_failed: true, error: safe }));
  }
  if (!resp || !resp.ok) {
    const status = resp ? resp.status : 'no-response';
    return items.map(() => ({ judge_failed: true, error: `http ${status}` }));
  }
  let payload;
  try {
    payload = await resp.json();
  } catch (err) {
    return items.map(() => ({ judge_failed: true, error: 'invalid json' }));
  }
  const text =
    (payload &&
      Array.isArray(payload.content) &&
      payload.content[0] &&
      typeof payload.content[0].text === 'string' &&
      payload.content[0].text) ||
    '';
  const verdicts = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = REPLY_LINE_REGEX.exec(line);
    if (m) verdicts.set(Number(m[1]), m[2].toLowerCase() === 'yes');
  }
  return items.map((_, i) => {
    const v = verdicts.get(i + 1);
    if (v === undefined) return { judge_failed: true, error: 'missing reply line' };
    return { relevant: v };
  });
}

/**
 * `sampleForCap(items, cap)` — when `items.length > cap`, return `cap`
 * items evenly sampled per `Math.floor(i * fires / cap)` and flag
 * `extrapolated:true`. Otherwise return all items unchanged.
 */
function sampleForCap(items, cap) {
  const fires = items.length;
  if (fires <= cap) return { sampled: items.slice(), extrapolated: false };
  const sampled = [];
  for (let i = 0; i < cap; i++) {
    sampled.push(items[Math.floor((i * fires) / cap)]);
  }
  return { sampled, extrapolated: true };
}

/**
 * `judgePipeline(items, {fetchImpl, apiKey, model, maxJudges})` —
 * applies `sampleForCap` then dispatches `judgeBatch` calls in batches
 * of `JUDGE_BATCH_SIZE` (R18). Honors `--max-judges` as a hard upper
 * bound on judge API calls (G8 / P0 #6).
 */
async function judgePipeline(items, { fetchImpl, apiKey, model, maxJudges } = {}) {
  const { sampled, extrapolated } = sampleForCap(items, maxJudges);
  const results = [];
  for (let i = 0; i < sampled.length; i += JUDGE_BATCH_SIZE) {
    const batch = sampled.slice(i, i + JUDGE_BATCH_SIZE);
    // eslint-disable-next-line no-await-in-loop
    const batchResults = await judgeBatch(batch, { fetchImpl, apiKey, model });
    for (let j = 0; j < batch.length; j++) {
      results.push({ ...batch[j], ...batchResults[j] });
    }
  }
  return { results, extrapolated };
}

module.exports = {
  parseFlags,
  die,
  extractEvents,
  parseSince,
  walkTranscripts,
  iterLines,
  replayEvent,
  loadStore,
  loadMemories,
  splitTopLevelAlternation,
  aggregateReport,
  suggestTightening,
  fpRate,
  renderJson,
  renderReport,
  judgeBatch,
  sampleForCap,
  judgePipeline,
  shouldJudge,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`synapsys-replay: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  });
}
