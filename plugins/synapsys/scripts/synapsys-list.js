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

const { flag } = setupCli();

const cwd = flag('cwd') || process.cwd();
const json = !!flag('json');
const verbose = !!flag('verbose');
const noColor = !!flag('no-color') || process.env.NO_COLOR === '1' || !process.stdout.isTTY;
const storeFilter = typeof flag('store') === 'string' ? flag('store') : null;
const eventFilter = typeof flag('event') === 'string' ? flag('event') : null;

const stores = discoverStores(cwd);
let memories = stores.flatMap(listMemoriesFromStore);
if (storeFilter) memories = memories.filter((m) => m.store.kind === storeFilter);
if (eventFilter) memories = memories.filter((m) => m.events.includes(eventFilter));

if (json) {
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
          inject: m.inject,
          store: m.store.kind,
          file: m.file,
        })),
      },
      null,
      2
    )}\n`
  );
  process.exit(0);
}

// ─── styling ──────────────────────────────────────────────────────────
const C = noColor
  ? new Proxy({}, { get: () => (s) => String(s) })
  : {
      dim: (s) => `\x1b[2m${s}\x1b[0m`,
      bold: (s) => `\x1b[1m${s}\x1b[0m`,
      cyan: (s) => `\x1b[36m${s}\x1b[0m`,
      green: (s) => `\x1b[32m${s}\x1b[0m`,
      yellow: (s) => `\x1b[33m${s}\x1b[0m`,
      magenta: (s) => `\x1b[35m${s}\x1b[0m`,
      red: (s) => `\x1b[31m${s}\x1b[0m`,
      blue: (s) => `\x1b[34m${s}\x1b[0m`,
      gray: (s) => `\x1b[90m${s}\x1b[0m`,
    };

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

// ─── empty cases ──────────────────────────────────────────────────────
if (!stores.length) {
  console.log(C.yellow('No Synapsys stores installed.'));
  console.log(C.dim('Run /synapsys:install to create one.'));
  process.exit(0);
}

if (!memories.length) {
  for (const s of stores) {
    console.log(`${C.cyan(s.kind.toUpperCase())} ${C.dim('·')} ${s.dir}`);
  }
  console.log(C.dim('\n(no memories — use /synapsys:memorize or /synapsys:crystallize)'));
  process.exit(0);
}

// ─── compute counts ───────────────────────────────────────────────────
const byStore = new Map();
for (const s of stores) byStore.set(s.kind, { dir: s.dir, memories: [] });
for (const m of memories) {
  const bucket = byStore.get(m.store.kind);
  if (bucket) bucket.memories.push(m);
}

let total = 0;
let upsCount = 0;
let ptuCount = 0;
let sessionCount = 0;
for (const m of memories) {
  total++;
  if (m.events.includes('UserPromptSubmit')) upsCount++;
  if (m.events.includes('PreToolUse')) ptuCount++;
  if (m.events.includes('SessionStart')) sessionCount++;
}

// ─── render ───────────────────────────────────────────────────────────
const termWidth =
  process.stdout.columns && process.stdout.columns > 80 ? process.stdout.columns : 100;
const longestName = Math.max(...memories.map((m) => m.name.length));
const nameWidth = Math.min(50, Math.max(longestName, 20));
const eventsWidth = 8;

for (const [kind, bucket] of byStore.entries()) {
  if (!bucket.memories.length) continue;

  // Store header
  console.log(
    `${C.cyan(C.bold(kind.toUpperCase()))} ${C.dim('·')} ${C.dim(bucket.dir)} ${C.dim('·')} ${bucket.memories.length} memories`
  );
  console.log(C.dim('─'.repeat(Math.min(termWidth, 120))));
  console.log('');

  // Rows: 2 lines per memory + blank line between
  //   line 1: NAME    EVENTS  I
  //   line 2:   <full description>
  bucket.memories.sort((a, b) => a.name.localeCompare(b.name));
  for (const m of bucket.memories) {
    const name = pad(m.name, nameWidth);
    const ev = pad(eventCode(m.events), eventsWidth);
    const injChar = m.inject === 'full' ? 'F' : 's';
    const injColored = m.inject === 'full' ? C.bold(C.red(injChar)) : C.gray(injChar);
    console.log(`  ${C.green(name)}  ${C.yellow(ev)}  ${injColored}`);
    console.log(`    ${m.description}`);

    if (verbose) {
      if (m.triggerPrompt)
        console.log(`    ${C.dim('prompt:')}  ${C.magenta('/' + m.triggerPrompt + '/i')}`);
      if (m.triggerPretool.length)
        console.log(`    ${C.dim('pretool:')} ${C.magenta(m.triggerPretool.join(', '))}`);
      if (m.triggerSession) console.log(`    ${C.dim('session:')} ${C.magenta('yes')}`);
      if (m.triggerStopResponse)
        console.log(`    ${C.dim('stop-response:')} ${C.magenta('/' + m.triggerStopResponse + '/i')}`);
      console.log(`    ${C.dim('file:')}    ${C.dim(m.file)}`);
    }
    console.log('');
  }
}

// ─── summary ──────────────────────────────────────────────────────────
const summary = `${C.bold(`Total: ${total}`)} ${C.dim('·')} UPS: ${C.yellow(upsCount)} ${C.dim('·')} PTU: ${C.yellow(ptuCount)} ${C.dim('·')} SS: ${C.yellow(sessionCount)}`;
console.log(summary);
// Build the legend in parts so the inner red/bold "F" doesn't reset the outer
// dim attribute (an inner \x1b[0m clears ALL attributes on the rest of the line).
const legendTail = verbose ? 'verbose mode (regexes shown)' : 'pass --verbose for triggers';
console.log(
  `${C.dim('Legend: ')}${C.red(C.bold('F'))}${C.dim(` = full inject · s = summary inject · ${legendTail}`)}`
);
