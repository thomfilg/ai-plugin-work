#!/usr/bin/env node
'use strict';

/**
 * Archive (soft-delete) one or more Synapsys memories.
 *
 *   node synapsys-forget.js <name> [<name>...]      — archive memories by name
 *   node synapsys-forget.js --all-from=<kind>       — archive all in a store kind
 *   node synapsys-forget.js --list                  — print inventory as JSON, exit (no deletion)
 *   node synapsys-forget.js --cwd=<path>            — override cwd
 *
 * Behavior:
 *   - Moves matching files to `<store>/_archive/<name>.<YYYYMMDD-HHMMSS>.md`
 *   - Never `rm` (recoverable). Creates `_archive/` if needed.
 *   - If a name matches in multiple stores, archives ALL matches (and reports each).
 *   - Exits non-zero only on usage errors. Missing names print a warning and continue.
 */

const fs = require('node:fs');
const path = require('node:path');
const { listMemories } = require(path.join(__dirname, '..', 'lib', 'memory-store'));
const { makeFlag } = require(path.join(__dirname, '..', 'lib', 'cli-args'));

const args = process.argv.slice(2);
const flag = makeFlag(args);

const cwd = flag('cwd') || process.cwd();
const listOnly = !!flag('list');
const allFromKind = typeof flag('all-from') === 'string' ? flag('all-from') : null;
const names = args.filter((a) => !a.startsWith('--'));

const memories = listMemories(cwd);

if (listOnly) {
  process.stdout.write(
    `${JSON.stringify(
      {
        memories: memories.map((m) => ({
          name: m.name,
          description: m.description,
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

if (!names.length && !allFromKind) {
  console.error('usage: synapsys-forget.js <name> [<name>...] | --all-from=<kind> | --list');
  process.exit(2);
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function archive(m) {
  const storeDir = path.dirname(m.file);
  const archiveDir = path.join(storeDir, '_archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  const dest = path.join(archiveDir, `${m.name}.${timestamp()}.md`);
  fs.renameSync(m.file, dest);
  return dest;
}

let targets = [];
if (allFromKind) {
  targets = memories.filter((m) => m.store.kind === allFromKind);
  if (!targets.length) {
    console.error(`no memories found in store kind '${allFromKind}'`);
    process.exit(1);
  }
} else {
  const nameSet = new Set(names);
  targets = memories.filter((m) => nameSet.has(m.name));
  const found = new Set(targets.map((m) => m.name));
  for (const n of names) if (!found.has(n)) console.warn(`warn: no memory named '${n}'`);
  if (!targets.length) process.exit(1);
}

const results = [];
for (const m of targets) {
  try {
    const dest = archive(m);
    results.push({ name: m.name, store: m.store.kind, archived: dest });
    console.log(`archived [${m.store.kind}] ${m.name} → ${dest}`);
  } catch (err) {
    console.error(`failed to archive ${m.name}: ${err.message}`);
  }
}

console.log(`\nForgot ${results.length} memories.`);
