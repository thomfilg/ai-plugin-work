#!/usr/bin/env node
'use strict';

/**
 * synapsys-replay-next — phase-next runner (GH-517 Task 2).
 *
 * One invocation == one envelope. The runner state lives in
 * `<runDir>/state.json` so the SKILL.md loop can drive walk → judge →
 * aggregate → report by re-invoking us between dispatcher turns.
 *
 * Envelopes (JSON, single line of stdout):
 *   walk      → { current_phase:'walk', action:'continue', next_phase }
 *   judge     → { current_phase:'judge', action:'dispatch_agent',
 *                 subagent_type, input_file, output_file, remaining }
 *   aggregate → { current_phase:'aggregate', action:'continue', next_phase:'report' }
 *   report    → { current_phase:'report', action:'done', report_path, stdout_payload }
 *
 * Exit 0 on success, 2 on misconfig, 1 on unexpected error.
 */

const fs = require('node:fs');
const path = require('node:path');
const { makeFlag } = require('../lib/cli-args');
const memoryStore = require('../lib/memory-store');
const events = require('../lib/replay-events');
const aggregate = require('../lib/replay-aggregate');
const report = require('../lib/replay-report');
const batch = require('../lib/replay-judge-batch');
const stateMod = require('../lib/replay-next-state');

const { extractEvents, walkTranscripts, iterLines, replayEvent } = events;
const { aggregateReport, suggestTightening } = aggregate;
const { renderJson, renderReport } = report;
const { buildBatchInput, parseBatchOutput, sampleForCap, JUDGE_BATCH_SIZE } = batch;
const { loadState, saveState, batchInPath, batchOutPath, pickNextBatch } = stateMod;

const AGENT_NAME = 'synapsys-replay-judge';
const DEFAULT_RUN_DIR = '.synapsys-replay';

// On-disk batch files are human-numbered (1-based): the internal batch index
// `i` (0-based) maps to `batch-<i+1>.in.json` / `batch-<i+1>.out.json`. This
// keeps the dispatched payload "numbered" (batch-1 is the first batch) while
// the in-memory pending list stays 0-based.
function inPath(runDir, i) {
  return batchInPath(runDir, i + 1);
}
function outPath(runDir, i) {
  return batchOutPath(runDir, i + 1);
}
function recomputePendingNumbered(runDir, batchCount) {
  const pending = [];
  for (let i = 0; i < batchCount; i++) {
    if (!fs.existsSync(outPath(runDir, i))) pending.push(i);
  }
  return pending;
}

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
    runDir: typeof flag('run-dir') === 'string' ? flag('run-dir') : undefined,
  };
}

function die(msg, code = 2) {
  process.stderr.write(`synapsys-replay-next: ${msg}\n`);
  process.exit(code);
}

function validateFlags(flags) {
  if (!/^\d+d$/.test(flags.since)) die(`invalid --since=${flags.since}`);
  if (flags.project !== undefined) {
    if (!/^[\w.-]+$/.test(flags.project) || /\.\./.test(flags.project) || flags.project === '.') {
      die(`invalid --project=${flags.project}`);
    }
  }
  if (!Number.isInteger(flags.maxJudges) || flags.maxJudges < 1) {
    die(`invalid --max-judges=${flags.maxJudges}`);
  }
}

function resolveRunDir(flags, cwd) {
  return path.resolve(flags.runDir || path.join(cwd, DEFAULT_RUN_DIR));
}

function tryLoadStores(flags, cwd) {
  try {
    const stores = memoryStore.discoverStores(cwd);
    if (!flags.store) return stores;
    const byKind = stores.filter((s) => s.kind === flags.store);
    if (byKind.length) return byKind;
    const abs = path.resolve(flags.store);
    const byPath = stores.filter((s) => path.resolve(s.dir) === abs);
    if (byPath.length) return byPath;
    if (fs.existsSync(path.join(abs, '.synapsys.json'))) {
      return [{ kind: 'path', dir: abs, projectName: path.basename(abs) }];
    }
    return [];
  } catch {
    return [];
  }
}

function loadMemories(stores) {
  const all = [];
  for (const s of stores) {
    try {
      all.push(...memoryStore.listMemoriesFromStore(s));
    } catch {
      /* skip */
    }
  }
  return all;
}

function applyOnlyFilter(memories, onlyFlag) {
  if (!onlyFlag) return memories;
  const allow = new Set(
    onlyFlag
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  return memories.filter((m) => allow.has(m.name));
}

function collectTuples(files, memories) {
  const tuples = [];
  const counts = { total: 0, ups: 0, ptu: 0 };
  for (const file of files) {
    for (const parsed of iterLines(file)) {
      for (const ev of extractEvents(parsed)) {
        counts.total += 1;
        if (ev.event === 'UserPromptSubmit') counts.ups += 1;
        else if (ev.event === 'PreToolUse') counts.ptu += 1;
        for (const t of replayEvent(memories, ev)) {
          if (t.fired && ev.event === 'UserPromptSubmit') t.prompt = ev.prompt;
          tuples.push(t);
        }
      }
    }
  }
  return { tuples, counts };
}

function buildJudgeItems(tuples, memories) {
  const bodyByName = new Map((memories || []).map((m) => [m.name, (m.body || '').slice(0, 200)]));
  return tuples
    .filter((t) => t.fired && t.event === 'UserPromptSubmit')
    .map((t) => ({
      memory: t.memory_name,
      body: bodyByName.get(t.memory_name) || '',
      prompt: t.prompt,
      matched: t.matched_substring,
    }));
}

function emit(envelope) {
  process.stdout.write(JSON.stringify(envelope) + '\n');
  process.exit(0);
}

function persistTuples(runDir, tuples, counts, meta) {
  fs.writeFileSync(path.join(runDir, 'tuples.json'), JSON.stringify({ tuples, counts, meta }));
}

function loadTuplesFile(runDir) {
  const f = path.join(runDir, 'tuples.json');
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}

function writeBatchInputs(runDir, batches) {
  for (let i = 0; i < batches.length; i++) {
    fs.writeFileSync(inPath(runDir, i), JSON.stringify(batches[i]));
  }
}

function buildBatches(items) {
  const batches = [];
  for (let i = 0; i < items.length; i += JUDGE_BATCH_SIZE) {
    batches.push(buildBatchInput(items.slice(i, i + JUDGE_BATCH_SIZE)));
  }
  return batches;
}

function doWalk(flags, runDir, cwd) {
  fs.mkdirSync(runDir, { recursive: true });
  const stores = tryLoadStores(flags, cwd);
  const memories = applyOnlyFilter(loadMemories(stores), flags.only);
  const files = walkTranscripts({
    since: flags.since,
    project: flags.project,
    baseDir: flags.transcriptsBase,
    cwd,
    allProjects: flags.allProjects || !!flags.transcriptsBase,
  });

  const { tuples, counts } = collectTuples(files, memories);
  const meta = {
    store: stores.map((s) => s.dir).join(','),
    window: flags.since,
    events_total: counts.total,
    events_ups: counts.ups,
    events_ptu: counts.ptu,
    memoryNames: memories.map((m) => m.name),
    memoryTriggers: memories.map((m) => ({ name: m.name, triggerPrompt: m.triggerPrompt })),
  };
  persistTuples(runDir, tuples, counts, meta);

  const items = buildJudgeItems(tuples, memories);
  let extrapolated = false;
  let toBatch = items;
  if (items.length > 0 && Number.isFinite(flags.maxJudges)) {
    const cap = flags.maxJudges;
    if (items.length > cap) {
      const result = sampleForCap(items, cap);
      toBatch = result.sampled;
      extrapolated = result.extrapolated;
    }
  }

  const batches = flags.noJudge || toBatch.length === 0 ? [] : buildBatches(toBatch);
  writeBatchInputs(runDir, batches);

  const skipJudge = flags.noJudge || batches.length === 0;
  const state = {
    version: 1,
    phase: skipJudge ? 'aggregate' : 'judge',
    noJudge: !!flags.noJudge,
    extrapolated,
    batchCount: batches.length,
    pending: batches.map((_, i) => i),
    flags: { json: !!flags.json },
  };
  saveState(runDir, state);

  return { current_phase: 'walk', action: 'continue', next_phase: skipJudge ? 'aggregate' : 'judge', ticket: null };
}

function doJudge(state, runDir) {
  state.pending = recomputePendingNumbered(runDir, state.batchCount);
  if (state.pending.length === 0) {
    state.phase = 'aggregate';
    saveState(runDir, state);
    return { current_phase: 'judge', action: 'continue', next_phase: 'aggregate' };
  }
  const next = pickNextBatch(state);
  saveState(runDir, state);
  return {
    current_phase: 'judge',
    action: 'dispatch_agent',
    subagent_type: AGENT_NAME,
    input_file: path.resolve(inPath(runDir, next)),
    output_file: path.resolve(outPath(runDir, next)),
    remaining: state.pending.length,
  };
}

function tallyJudgment(judgments, entry) {
  if (!judgments[entry.memory]) judgments[entry.memory] = { relevant: 0, irrelevant: 0, judge_failed: 0 };
  if (entry.relevant === 'yes') judgments[entry.memory].relevant += 1;
  else if (entry.relevant === 'no') judgments[entry.memory].irrelevant += 1;
  else judgments[entry.memory].judge_failed += 1;
}

function mergeJudgments(runDir, batchCount) {
  const judgments = {};
  for (let i = 0; i < batchCount; i++) {
    const inFile = inPath(runDir, i);
    const outFile = outPath(runDir, i);
    if (!fs.existsSync(outFile) || !fs.existsSync(inFile)) continue;
    const inputBatch = JSON.parse(fs.readFileSync(inFile, 'utf8'));
    const parsed = parseBatchOutput(fs.readFileSync(outFile, 'utf8'), inputBatch);
    for (const entry of parsed) tallyJudgment(judgments, entry);
  }
  fs.writeFileSync(path.join(runDir, 'judgments.json'), JSON.stringify(judgments));
  return judgments;
}

function nullOutRelevance(agg) {
  for (const name of Object.keys(agg)) {
    agg[name].relevant = null;
    agg[name].irrelevant = null;
    agg[name].fp_rate = null;
  }
}

function doAggregate(state, runDir) {
  const tup = loadTuplesFile(runDir) || { tuples: [], counts: {}, meta: {} };
  const judgments = state.noJudge ? null : mergeJudgments(runDir, state.batchCount);
  const agg = aggregateReport(tup.tuples, judgments || undefined);
  if (state.noJudge) nullOutRelevance(agg);
  fs.writeFileSync(path.join(runDir, 'aggregate.json'), JSON.stringify(agg));
  state.phase = 'report';
  saveState(runDir, state);
  return { current_phase: 'aggregate', action: 'continue', next_phase: 'report' };
}

function buildReportMeta(state, tup, flags) {
  const m = tup.meta || {};
  return {
    store: m.store || '',
    window: m.window || flags.since,
    events_total: m.events_total || 0,
    events_ups: m.events_ups || 0,
    events_ptu: m.events_ptu || 0,
    judgeCalls: state.batchCount || 0,
    itemsJudged: 0,
    extrapolated: !!state.extrapolated,
  };
}

function doReport(state, runDir, flags) {
  const tup = loadTuplesFile(runDir) || { tuples: [], counts: {}, meta: {} };
  const aggFile = path.join(runDir, 'aggregate.json');
  const agg = fs.existsSync(aggFile) ? JSON.parse(fs.readFileSync(aggFile, 'utf8')) : {};
  const triggers = (tup.meta && tup.meta.memoryTriggers) || [];
  const suggestions = [];
  for (const m of triggers) {
    const sug = suggestTightening(m, agg[m.name]);
    if (sug) suggestions.push(sug);
  }
  const meta = buildReportMeta(state, tup, flags);
  const useJson = !!(state.flags && state.flags.json) || !!flags.json;
  const payload = useJson ? renderJson(agg, suggestions, meta) : renderReport(agg, suggestions, meta);
  const reportPath = path.join(runDir, useJson ? 'report.json' : 'report.txt');
  fs.writeFileSync(reportPath, payload);
  state.phase = 'done';
  saveState(runDir, state);
  return { current_phase: 'report', action: 'done', report_path: reportPath, stdout_payload: payload };
}

function emptyReportEnvelope(runDir, flags) {
  fs.mkdirSync(runDir, { recursive: true });
  const meta = {
    store: '', window: flags.since, events_total: 0, events_ups: 0, events_ptu: 0,
    judgeCalls: 0, itemsJudged: 0, extrapolated: false,
  };
  const payload = flags.json ? renderJson({}, [], meta) : 'no transcripts in window\n';
  const reportPath = path.join(runDir, flags.json ? 'report.json' : 'report.txt');
  fs.writeFileSync(reportPath, payload);
  return { current_phase: 'report', action: 'done', report_path: reportPath, stdout_payload: payload };
}

function maybeEmptyReport(flags, runDir, cwd) {
  const stores = tryLoadStores(flags, cwd);
  const files = walkTranscripts({
    since: flags.since, project: flags.project, baseDir: flags.transcriptsBase,
    cwd, allProjects: flags.allProjects || !!flags.transcriptsBase,
  });
  return stores.length === 0 && files.length === 0;
}

function main(argv) {
  const flags = parseFlags(argv);
  validateFlags(flags);
  const cwd = process.cwd();
  const runDir = resolveRunDir(flags, cwd);

  let state = loadState(runDir);
  if (!state) {
    if (maybeEmptyReport(flags, runDir, cwd)) emit(emptyReportEnvelope(runDir, flags));
    emit(doWalk(flags, runDir, cwd));
  }
  if (state.phase === 'judge') emit(doJudge(state, runDir));
  if (state.phase === 'aggregate') emit(doAggregate(state, runDir));
  if (state.phase === 'report' || state.phase === 'done') emit(doReport(state, runDir, flags));
  die(`unknown phase: ${state.phase}`, 1);
}

module.exports = { parseFlags, main };

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (err) {
    process.stderr.write(`synapsys-replay-next: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
}
