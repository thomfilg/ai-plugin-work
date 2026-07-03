#!/usr/bin/env node
'use strict';

/**
 * synapsys-replay — thin alias around `synapsys-replay-next.js` (GH-517 Task 3).
 *
 * The legacy direct-API judge path is gone. This entrypoint now exists only
 * to keep the historical command name working: it prints a single-line
 * deprecation notice on stderr and delegates to the phase-next runner.
 *
 * Removed surfaces (intentional):
 *   - `judgeBatch`, `judgePipeline`, `sampleForCap`, `shouldJudge` re-exports
 *   - `process.env.ANTHROPIC_API_KEY` reads
 *   - the "ANTHROPIC_API_KEY not set; proceeding as --no-judge" stderr warning
 *   - `require('../lib/replay-judge')` (the file is deleted)
 *
 * Preserved module surface (still consumed by sibling integration tests):
 *   - pure flag parser + validators
 *   - re-exports of `extractEvents`, `walkTranscripts`, `iterLines`,
 *     `replayEvent`, `parseSince`, `aggregateReport`, `suggestTightening`,
 *     `splitTopLevelAlternation`, `fpRate`, `renderJson`, `renderReport`,
 *     `loadStore`, `loadMemories`
 *
 * Exit codes match the next-runner: 0 success, 2 misconfig, 1 unexpected error.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeFlag } = require('../lib/cli-args');
const memoryStore = require('../lib/memory-store');
const events = require('../lib/replay-events');
const aggregate = require('../lib/replay-aggregate');
const report = require('../lib/replay-report');

const { extractEvents, parseSince, walkTranscripts, iterLines, replayEvent } = events;
const { splitTopLevelAlternation, fpRate, aggregateReport, suggestTightening } = aggregate;
const { renderJson, renderReport } = report;

const NEXT_RUNNER = path.resolve(__dirname, 'synapsys-replay-next.js');

/**
 * Pure flag parser — retained so consumers that imported `parseFlags`
 * directly continue to work. No I/O, no process exits.
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

function die(msg, code = 2) {
  process.stderr.write(`synapsys-replay: ${msg}\n`);
  process.exit(code);
}

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

function loadMemories(stores) {
  const all = [];
  for (const s of stores) {
    all.push(...memoryStore.listMemoriesFromStore(s));
  }
  return all;
}

// Phase-next is a one-envelope-per-invocation runner: walk → judge →
// aggregate → report. The deprecated alias preserves the historical
// single-command UX by driving that loop to completion itself, re-invoking the
// next runner until it emits a terminal `action:'done'` (or a `dispatch_agent`,
// which the alias cannot fulfil — see below). A shared `--run-dir` threads the
// runner state across invocations.
const MAX_PHASE_ITERS = 200;

function lastJsonLine(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      /* not json */
    }
  }
  return null;
}

/**
 * Delegate to `synapsys-replay-next.js`. Prints a one-line deprecation notice
 * on stderr, then drives the phase-next loop to its terminal report envelope,
 * propagating the runner's stdout/stderr verbatim each turn. A non-judge run
 * (`--no-judge`, or a window with no fires) walks straight through to the
 * report; the alias does not dispatch the judge subagent itself, so a
 * `dispatch_agent` envelope ends the loop with the dispatch instruction left
 * for the caller (matching the deprecated command's hands-off behavior).
 */
function main(argv) {
  process.stderr.write(
    'synapsys-replay: deprecated entrypoint — delegating to synapsys-replay-next.js\n'
  );
  // Pin a single run directory so runner state persists across phase turns,
  // unless the caller already chose one.
  const hasRunDir = argv.some((a) => a === '--run-dir' || a.startsWith('--run-dir='));
  const runDir = hasRunDir ? null : fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'synapsys-replay-'));
  const childArgs = hasRunDir ? argv : [...argv, `--run-dir=${runDir}`];

  let lastStatus = 1;
  for (let i = 0; i < MAX_PHASE_ITERS; i++) {
    const result = spawnSync(process.execPath, [NEXT_RUNNER, ...childArgs], {
      encoding: 'utf8',
    });
    if (result.error) {
      process.stderr.write(`synapsys-replay: ${result.error.message}\n`);
      process.exit(1);
    }
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    lastStatus = typeof result.status === 'number' ? result.status : 1;
    if (lastStatus !== 0) break;

    const envelope = lastJsonLine(result.stdout);
    // Terminal report, an instruction the alias cannot fulfil, or an
    // unparseable line all stop the loop. `continue`/`walk` re-invoke.
    if (!envelope || envelope.action === 'done' || envelope.action === 'dispatch_agent') break;
  }
  process.exit(lastStatus);
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
  main,
};

if (require.main === module) {
  main(process.argv.slice(2));
}
