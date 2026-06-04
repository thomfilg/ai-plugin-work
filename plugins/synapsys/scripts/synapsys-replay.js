#!/usr/bin/env node
'use strict';

/**
 * synapsys-replay — replay recent Claude Code transcripts against the
 * runtime trigger matcher to surface noisy / mis-tuned synapsys memories.
 *
 * GH-444. The implementation is split across sibling modules to keep this
 * CLI entrypoint under the 400-line quality cap:
 *
 *   - lib/replay-events.js    — extractEvents, walkTranscripts, iterLines, replayEvent, parseSince
 *   - lib/replay-aggregate.js — aggregateReport, suggestTightening, splitTopLevelAlternation, fpRate
 *   - lib/replay-judge.js     — judgeBatch, judgePipeline, sampleForCap
 *   - lib/replay-report.js    — renderJson, renderReport
 *
 * This file owns flag parsing, validation, store loading, the main()
 * pipeline orchestration, and the public re-exports consumed by tests.
 */

const fs = require('node:fs');
const path = require('node:path');
const { makeFlag } = require('../lib/cli-args');
const memoryStore = require('../lib/memory-store');
const events = require('../lib/replay-events');
const aggregate = require('../lib/replay-aggregate');
const judge = require('../lib/replay-judge');
const report = require('../lib/replay-report');

const { extractEvents, parseSince, walkTranscripts, iterLines, replayEvent } = events;
const { splitTopLevelAlternation, fpRate, aggregateReport, suggestTightening } = aggregate;
const { judgeBatch, sampleForCap, judgePipeline, JUDGE_BATCH_SIZE } = judge;
const { renderJson, renderReport } = report;

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
 *   --all-projects      scan every ~/.claude/projects/* dir (default: only the cwd-hashed project)
 */
function parseFlags(argv) {
  const flag = makeFlag(argv);
  const sinceRaw = flag('since');
  const maxJudgesRaw = flag('max-judges');
  return {
    since: sinceRaw === undefined || sinceRaw === true ? '7d' : sinceRaw,
    project: typeof flag('project') === 'string' ? flag('project') : undefined,
    noJudge: flag('no-judge') === true,
    json: flag('json') === true,
    only: typeof flag('only') === 'string' ? flag('only') : undefined,
    store: typeof flag('store') === 'string' ? flag('store') : undefined,
    maxJudges: maxJudgesRaw === undefined || maxJudgesRaw === true ? 200 : Number(maxJudgesRaw),
    allProjects: flag('all-projects') === true,
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
 * Centralised judge gate. Returns true only when judging is allowed AND warranted:
 *   - `--no-judge` not set, `ANTHROPIC_API_KEY` present, ≥1 UPS fire.
 */
function shouldJudge({ noJudge, apiKey, upsFires }) {
  if (noJudge) return false;
  if (!apiKey) return false;
  if (!upsFires || upsFires <= 0) return false;
  return true;
}

/**
 * Resolve `--store` flag against `discoverStores(cwd)`. Mirrors the selector
 * logic in scripts/synapsys-explain.js (GH-443). Dies(2) on unknown store.
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
  if (fs.existsSync(path.join(abs, '.synapsys.json'))) {
    return [{ kind: 'path', dir: abs, projectName: path.basename(abs) }];
  }
  die(`unknown --store "${storeFlag}" (no matching discovered store)`, 2);
}

/**
 * Load all memories from a list of discovered stores.
 */
function loadMemories(stores) {
  const all = [];
  for (const s of stores) {
    all.push(...memoryStore.listMemoriesFromStore(s));
  }
  return all;
}

function validateFlags(flags) {
  if (!/^\d+d$/.test(flags.since)) {
    die(`invalid --since=${flags.since} (expected format like 7d, 14d)`);
  }
  if (flags.project !== undefined) {
    // Reject path-traversal: `..`, `.`, or any value containing consecutive
    // dots. The character class `[\w.-]+` alone permits `..` which
    // `path.join` resolves outside ~/.claude/projects/.
    if (!/^[\w.-]+$/.test(flags.project) || /\.\./.test(flags.project) || flags.project === '.') {
      die(`invalid --project=${flags.project}`);
    }
  }
  if (!Number.isInteger(flags.maxJudges) || flags.maxJudges < 1) {
    die(`invalid --max-judges=${flags.maxJudges} (expected positive integer)`);
  }
}

function applyOnlyFilter(memories, onlyFlag) {
  if (!onlyFlag) return memories;
  const allow = new Set(
    onlyFlag
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const known = new Set(memories.map((m) => m.name));
  const unknown = [...allow].filter((n) => !known.has(n));
  if (unknown.length > 0) {
    process.stderr.write(
      `synapsys-replay: --only references unknown memory name(s): ${unknown.join(', ')}\n`
    );
  }
  if (unknown.length === allow.size && allow.size > 0) {
    die(`--only matched no memories in the store (unknown: ${[...allow].join(', ')})`, 2);
  }
  return memories.filter((m) => allow.has(m.name));
}

function bumpCounts(counts, eventKind) {
  counts.total += 1;
  if (eventKind === 'UserPromptSubmit') counts.ups += 1;
  else if (eventKind === 'PreToolUse') counts.ptu += 1;
}

function processEvent(ev, memories, tuples) {
  for (const t of replayEvent(memories, ev)) {
    if (t.fired && ev.event === 'UserPromptSubmit') t.prompt = ev.prompt;
    tuples.push(t);
  }
}

function collectTuplesFromFiles(files, memories) {
  const tuples = [];
  const counts = { total: 0, ups: 0, ptu: 0 };
  for (const file of files) {
    for (const parsed of iterLines(file)) {
      for (const ev of extractEvents(parsed)) {
        bumpCounts(counts, ev.event);
        processEvent(ev, memories, tuples);
      }
    }
  }
  return { tuples, counts };
}

function tallyJudgmentResult(judgments, r) {
  if (!judgments[r.memory]) {
    judgments[r.memory] = { relevant: 0, irrelevant: 0, judge_failed: 0 };
  }
  if (r.judge_failed) judgments[r.memory].judge_failed += 1;
  else if (r.relevant === true) judgments[r.memory].relevant += 1;
  else if (r.relevant === false) judgments[r.memory].irrelevant += 1;
}

async function runJudgePhase(tuples, flags, apiKey, memories) {
  const bodyByName = new Map((memories || []).map((m) => [m.name, (m.body || '').slice(0, 200)]));
  const items = tuples
    .filter((t) => t.fired && t.event === 'UserPromptSubmit')
    .map((t) => ({
      memory: t.memory_name,
      body: bodyByName.get(t.memory_name) || '',
      prompt: t.prompt,
      matched: t.matched_substring,
    }));
  const pipeline = await judgePipeline(items, {
    apiKey,
    model: 'claude-haiku-4-5',
    maxJudges: flags.maxJudges,
  });
  const judgments = {};
  for (const r of pipeline.results) tallyJudgmentResult(judgments, r);
  return {
    judgments,
    judgeCalls: Math.ceil(pipeline.results.length / JUDGE_BATCH_SIZE),
    itemsJudged: pipeline.results.length,
    extrapolated: pipeline.extrapolated,
  };
}

function nullOutRelevance(agg) {
  for (const name of Object.keys(agg)) {
    agg[name].relevant = null;
    agg[name].irrelevant = null;
    agg[name].fp_rate = null;
  }
}

function buildSuggestions(memories, agg) {
  const suggestions = [];
  for (const memory of memories) {
    const sug = suggestTightening(memory, agg[memory.name]);
    if (sug) suggestions.push(sug);
  }
  return suggestions;
}

function writeOutput(flags, agg, suggestions, meta) {
  if (flags.json) {
    process.stdout.write(renderJson(agg, suggestions, meta) + '\n');
  } else {
    process.stdout.write(renderReport(agg, suggestions, meta));
  }
}

/**
 * Wired main() entrypoint. Pipeline:
 *   parseFlags → validate → loadStore → loadMemories (apply --only)
 *   → walkTranscripts → iterLines → extractEvents → replayEvent
 *   → (optional) judgePipeline → aggregateReport → suggestTightening
 *   → renderReport / renderJson → exit
 *
 * Validation precedes I/O so misconfigs exit 2 before any filesystem/network
 * touches. No-transcripts window prints a friendly message (R12 / G10).
 * Missing `ANTHROPIC_API_KEY` without `--no-judge` emits a single stderr
 * notice and proceeds as `--no-judge` (spec §Security / AC5).
 */
async function main(argv) {
  const flags = parseFlags(argv);
  validateFlags(flags);

  const stores = loadStore({ storeFlag: flags.store, cwd: process.cwd() });
  const memories = applyOnlyFilter(loadMemories(stores), flags.only);

  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  if (!flags.noJudge && !apiKey) {
    process.stderr.write('synapsys-replay: ANTHROPIC_API_KEY not set; proceeding as --no-judge\n');
  }

  const files = walkTranscripts({
    since: flags.since,
    project: flags.project,
    baseDir: flags.transcriptsBase,
    cwd: process.cwd(),
    // --transcripts-base is a test escape hatch with synthetic project layouts,
    // so treat it like --all-projects to keep test fixtures cwd-independent.
    allProjects: flags.allProjects || !!flags.transcriptsBase,
  });
  if (files.length === 0) {
    if (flags.json) {
      process.stdout.write(
        `${JSON.stringify({
          memories: [],
          suggestions: [],
          store: stores.map((s) => s.dir).join(','),
          window: flags.since,
          events_total: 0,
          events_ups: 0,
          events_ptu: 0,
          judge_calls: 0,
          items_judged: 0,
          extrapolated: false,
          message: 'no transcripts in window',
        })}\n`
      );
    } else {
      process.stdout.write('no transcripts in window\n');
    }
    process.exit(0);
  }

  const { tuples, counts } = collectTuplesFromFiles(files, memories);

  const upsFires = tuples.filter((t) => t.fired && t.event === 'UserPromptSubmit').length;
  const judging = shouldJudge({ noJudge: flags.noJudge, apiKey, upsFires });

  let judgments;
  let judgeCalls = 0;
  let itemsJudged = 0;
  let extrapolated = false;
  if (judging) {
    ({ judgments, judgeCalls, itemsJudged, extrapolated } = await runJudgePhase(
      tuples,
      flags,
      apiKey,
      memories
    ));
  }

  const agg = aggregateReport(tuples, judgments);
  if (!judging) nullOutRelevance(agg);
  const suggestions = buildSuggestions(memories, agg);

  const meta = {
    store: stores.map((s) => s.dir).join(','),
    window: flags.since,
    events_total: counts.total,
    events_ups: counts.ups,
    events_ptu: counts.ptu,
    judgeCalls,
    itemsJudged,
    extrapolated,
  };
  writeOutput(flags, agg, suggestions, meta);
  process.exit(0);
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
