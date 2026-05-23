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

const path = require('node:path');
const { listMemories, discoverStores } = require(path.join(__dirname, '..', 'lib', 'memory-store'));

const args = process.argv.slice(2);
function flag(name) {
  const a = args.find((x) => x === `--${name}` || x.startsWith(`--${name}=`));
  if (!a) return undefined;
  const eq = a.indexOf('=');
  return eq === -1 ? true : a.slice(eq + 1);
}

const cwd = flag('cwd') || process.cwd();
const json = !!flag('json');
const verbose = !!flag('verbose');
const noColor = !!flag('no-color') || process.env.NO_COLOR === '1' || !process.stdout.isTTY;
const storeFilter = typeof flag('store') === 'string' ? flag('store') : null;
const eventFilter = typeof flag('event') === 'string' ? flag('event') : null;

const stores = discoverStores(cwd);
let memories = listMemories(cwd);
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

function injectCode(inject) {
  return inject === 'full' ? 'F' : 's';
}

function pad(s, n) {
  if (s.length >= n) return s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}

function truncate(s, n) {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
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
const nameWidth = Math.min(40, Math.max(longestName, 20));
const eventsWidth = 8;
// inject column is 1 visible char ("F" or "s") rendered into a 1-wide cell
const descWidth = Math.max(30, termWidth - nameWidth - eventsWidth - 1 - 8);

for (const [kind, bucket] of byStore.entries()) {
  if (!bucket.memories.length) continue;

  // Store header
  console.log(
    `${C.cyan(C.bold(kind.toUpperCase()))} ${C.dim('·')} ${C.dim(bucket.dir)} ${C.dim('·')} ${bucket.memories.length} memories`
  );
  console.log(C.dim('─'.repeat(Math.min(termWidth, 120))));

  // Column header (raw strings, then dim the whole thing)
  const colHeader = `  ${pad('NAME', nameWidth)}  ${pad('EVENTS', eventsWidth)}  I  DESCRIPTION`;
  console.log(C.dim(colHeader));

  // Rows
  bucket.memories.sort((a, b) => a.name.localeCompare(b.name));
  for (const m of bucket.memories) {
    const name = pad(truncate(m.name, nameWidth), nameWidth);
    const ev = pad(eventCode(m.events), eventsWidth);
    const injChar = m.inject === 'full' ? 'F' : 's';
    const injColored = m.inject === 'full' ? C.bold(C.red(injChar)) : C.gray(injChar);
    const desc = truncate(m.description, descWidth);
    console.log(`  ${C.green(name)}  ${C.yellow(ev)}  ${injColored}  ${desc}`);

    if (verbose) {
      if (m.triggerPrompt)
        console.log(`    ${C.dim('prompt:')}  ${C.magenta('/' + m.triggerPrompt + '/i')}`);
      if (m.triggerPretool.length)
        console.log(`    ${C.dim('pretool:')} ${C.magenta(m.triggerPretool.join(', '))}`);
      if (m.triggerSession) console.log(`    ${C.dim('session:')} ${C.magenta('yes')}`);
      console.log(`    ${C.dim('file:')}    ${C.dim(m.file)}`);
    }
  }
  console.log('');
}

// ─── summary ──────────────────────────────────────────────────────────
const summary = `${C.bold(`Total: ${total}`)} ${C.dim('·')} UPS: ${C.yellow(upsCount)} ${C.dim('·')} PTU: ${C.yellow(ptuCount)} ${C.dim('·')} SS: ${C.yellow(sessionCount)}`;
console.log(summary);
console.log(
  C.dim(
    `Legend: ${C.red(C.bold('F'))} = full inject · s = summary inject · ${verbose ? 'verbose mode (regexes shown)' : 'pass --verbose for triggers'}`
  )
);
