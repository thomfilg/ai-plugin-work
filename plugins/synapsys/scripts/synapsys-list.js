#!/usr/bin/env node
'use strict';

/**
 * List all discovered Synapsys memories.
 *
 *   node synapsys-list.js [--store=<kind>] [--event=<EventName>]
 *                         [--verbose] [--json] [--no-color] [--cwd=<path>]
 *
 * Default: compact one-line-per-memory table.
 * --verbose: includes trigger regexes and file paths.
 * --json: raw machine-readable dump.
 */

const { discoverStores, listMemoriesFromStore, setupCli } = require('../lib/script-bootstrap');
const { makePalette } = require('../lib/ansi-palette');
const { resolveSessionId, loadLedger } = require('../lib/inject-ledger');

const { flag } = setupCli();

/**
 * Pure renderer for the `domain:` line shown per memory in `synapsys-list`.
 * Memories with a non-empty `domain` array render a comma-joined line;
 * absent/empty domain returns null (no line). Pre-styled with the palette.
 */
function formatDomainLine(domain, palette) {
  if (!Array.isArray(domain) || domain.length === 0) return null;
  const dim = palette && typeof palette.dim === 'function' ? palette.dim : (s) => s;
  const magenta = palette && typeof palette.magenta === 'function' ? palette.magenta : (s) => s;
  return `    ${dim('domain:')}  ${magenta(domain.join(', '))}`;
}

// fireIndicator — compact one-char marker + verbose suffix for fire_mode.
// Compact char: A (always), o (once, default), ~ (occasionally).
// Verbose string: `fire: <mode>[/<cadence>]   count: <n>` (cadence only when occasionally).
function fireIndicator(memory, count) {
  const mode = memory && memory.fireMode ? memory.fireMode : 'once';
  let char;
  if (mode === 'always') char = 'A';
  else if (mode === 'occasionally') char = '~';
  else char = 'o';
  const cadence = mode === 'occasionally' ? `/${memory.fireCadence}` : '';
  const verbose = `fire: ${mode}${cadence}   count: ${count}`;
  return { char, mode, verbose };
}

// Resolve session id + load ledger once per invocation (fail-open via module).
let __ledger;
try {
  __ledger = loadLedger(resolveSessionId({}));
} catch {
  __ledger = { memories: {} };
}
function injectedCountFor(name) {
  try {
    const e = __ledger && __ledger.memories && __ledger.memories[name];
    return e && Number.isFinite(Number(e.injectedCount)) ? Number(e.injectedCount) : 0;
  } catch {
    return 0;
  }
}

module.exports = { formatDomainLine };

if (require.main === module) {
  runCli();
}

function eventCode(events) {
  const parts = [];
  if (events.includes('UserPromptSubmit')) parts.push('UPS');
  if (events.includes('PreToolUse')) parts.push('PTU');
  if (events.includes('SessionStart')) parts.push('SS');
  return parts.join('+');
}

function pad(s, n) {
  if (s.length >= n) return s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}

function emitJsonOutput(stores, memories) {
  process.stdout.write(
    `${JSON.stringify(
      {
        stores,
        memories: memories.map((m) => ({
          name: m.name,
          description: m.description,
          events: m.events,
          triggerPrompt: m.triggerPrompt,
          triggerPretool: m.triggerPretool,
          triggerSession: m.triggerSession,
          triggerStopResponse: m.triggerStopResponse || '',
          excludePrompt: m.excludePrompt || '',
          excludePretool: Array.isArray(m.excludePretool) ? m.excludePretool : [],
          excludePreset: Array.isArray(m.excludePreset) ? m.excludePreset : [],
          inject: m.inject,
          domain: Array.isArray(m.domain) ? m.domain : [],
          fireMode: m.fireMode || 'once',
          fireCadence: typeof m.fireCadence === 'number' ? m.fireCadence : 5,
          injectedCount: injectedCountFor(m.name),
          store: m.store.kind,
          file: m.file,
        })),
      },
      null,
      2
    )}\n`
  );
}

function groupByStore(stores, memories) {
  const byStore = new Map();
  for (const s of stores) byStore.set(s.kind, { dir: s.dir, memories: [] });
  for (const m of memories) {
    const bucket = byStore.get(m.store.kind);
    if (bucket) bucket.memories.push(m);
  }
  return byStore;
}

function countByEvent(memories) {
  const out = { total: 0, ups: 0, ptu: 0, ss: 0 };
  for (const m of memories) {
    out.total++;
    if (m.events.includes('UserPromptSubmit')) out.ups++;
    if (m.events.includes('PreToolUse')) out.ptu++;
    if (m.events.includes('SessionStart')) out.ss++;
  }
  return out;
}

function fireColor(fi, C) {
  if (fi.char === 'A') return C.bold(C.red(fi.char));
  if (fi.char === '~') return C.yellow(fi.char);
  return C.gray(fi.char);
}

function renderVerbose(m, fi, C) {
  console.log(`    ${C.dim(fi.verbose)}`);
  if (m.triggerPrompt)
    console.log(`    ${C.dim('prompt:')}  ${C.magenta('/' + m.triggerPrompt + '/i')}`);
  if (m.triggerPretool.length)
    console.log(`    ${C.dim('pretool:')} ${C.magenta(m.triggerPretool.join(', '))}`);
  if (m.triggerSession) console.log(`    ${C.dim('session:')} ${C.magenta('yes')}`);
  if (m.triggerStopResponse)
    console.log(`    ${C.dim('stop-response:')} ${C.magenta('/' + m.triggerStopResponse + '/i')}`);
  if (m.excludePrompt)
    console.log(`    ${C.dim('exclude_prompt:')}  ${C.magenta('/' + m.excludePrompt + '/i')}`);
  if (Array.isArray(m.excludePretool) && m.excludePretool.length)
    console.log(`    ${C.dim('exclude_pretool:')} ${C.magenta(m.excludePretool.join(', '))}`);
  if (Array.isArray(m.excludePreset) && m.excludePreset.length)
    console.log(`    ${C.dim('exclude_preset:')}  ${C.magenta(m.excludePreset.join(', '))}`);
  console.log(`    ${C.dim('file:')}    ${C.dim(m.file)}`);
}

function renderMemoryRow(m, C, widths, verbose) {
  const name = pad(m.name, widths.name);
  const ev = pad(eventCode(m.events), widths.events);
  const injChar = m.inject === 'full' ? 'F' : 's';
  const injColored = m.inject === 'full' ? C.bold(C.red(injChar)) : C.gray(injChar);
  const fi = fireIndicator(m, injectedCountFor(m.name));
  console.log(`  ${C.green(name)}  ${C.yellow(ev)}  ${injColored} ${fireColor(fi, C)}`);
  console.log(`    ${m.description}`);
  const domainLine = formatDomainLine(m.domain, C);
  if (domainLine) console.log(domainLine);
  if (verbose) renderVerbose(m, fi, C);
  console.log('');
}

function renderBucket(kind, bucket, C, widths, verbose, termWidth) {
  if (!bucket.memories.length) return;
  console.log(
    `${C.cyan(C.bold(kind.toUpperCase()))} ${C.dim('·')} ${C.dim(bucket.dir)} ${C.dim('·')} ${bucket.memories.length} memories`
  );
  console.log(C.dim('─'.repeat(Math.min(termWidth, 120))));
  console.log('');
  bucket.memories.sort((a, b) => a.name.localeCompare(b.name));
  for (const m of bucket.memories) renderMemoryRow(m, C, widths, verbose);
}

function printSummary(C, counts, verbose) {
  console.log(
    `${C.bold(`Total: ${counts.total}`)} ${C.dim('·')} UPS: ${C.yellow(counts.ups)} ${C.dim('·')} PTU: ${C.yellow(counts.ptu)} ${C.dim('·')} SS: ${C.yellow(counts.ss)}`
  );
  const legendTail = verbose ? 'verbose mode (regexes shown)' : 'pass --verbose for triggers';
  console.log(
    `${C.dim('Legend: ')}${C.red(C.bold('F'))}${C.dim(` = full inject · s = summary inject · ${legendTail}`)}`
  );
}

function printEmptyStoresAndExit(C) {
  console.log(C.yellow('No Synapsys stores installed.'));
  console.log(C.dim('Run /synapsys:install to create one.'));
  process.exit(0);
}

function printEmptyMemoriesAndExit(stores, C) {
  for (const s of stores) console.log(`${C.cyan(s.kind.toUpperCase())} ${C.dim('·')} ${s.dir}`);
  console.log(C.dim('\n(no memories — use /synapsys:memorize or /synapsys:crystallize)'));
  process.exit(0);
}

function loadFilteredMemories(cwd, storeFilter, eventFilter) {
  const stores = discoverStores(cwd);
  let memories = stores.flatMap(listMemoriesFromStore);
  if (storeFilter) memories = memories.filter((m) => m.store.kind === storeFilter);
  if (eventFilter) memories = memories.filter((m) => m.events.includes(eventFilter));
  return { stores, memories };
}

function parseCliOpts() {
  return {
    cwd: flag('cwd') || process.cwd(),
    json: !!flag('json'),
    verbose: !!flag('verbose'),
    noColor: !!flag('no-color') || process.env.NO_COLOR === '1' || !process.stdout.isTTY,
    storeFilter: typeof flag('store') === 'string' ? flag('store') : null,
    eventFilter: typeof flag('event') === 'string' ? flag('event') : null,
  };
}

function computeRenderWidths(memories) {
  const termWidth =
    process.stdout.columns && process.stdout.columns > 80 ? process.stdout.columns : 100;
  const longestName = Math.max(...memories.map((m) => m.name.length));
  return { name: Math.min(50, Math.max(longestName, 20)), events: 8, term: termWidth };
}

function renderHuman(stores, memories, opts) {
  const C = makePalette(opts.noColor);
  if (!stores.length) printEmptyStoresAndExit(C);
  if (!memories.length) printEmptyMemoriesAndExit(stores, C);
  const byStore = groupByStore(stores, memories);
  const widths = computeRenderWidths(memories);
  for (const [kind, bucket] of byStore.entries()) {
    renderBucket(kind, bucket, C, widths, opts.verbose, widths.term);
  }
  printSummary(C, countByEvent(memories), opts.verbose);
}

function runCli() {
  const opts = parseCliOpts();
  const { stores, memories } = loadFilteredMemories(opts.cwd, opts.storeFilter, opts.eventFilter);
  if (opts.json) {
    emitJsonOutput(stores, memories);
    process.exit(0);
  }
  renderHuman(stores, memories, opts);
}
