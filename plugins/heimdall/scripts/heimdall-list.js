#!/usr/bin/env node
'use strict';

/**
 * List Heimdall lock blocks across all active stores.
 *
 *   node heimdall-list.js [--cwd=<path>] [--json]
 *
 * Shows, per store, each lock block's unlock phrase, the protected paths, and
 * whether each resolves to a file or directory (resolved against the repo root).
 */

const path = require('node:path');
const { discoverStores, readConfig, getRepoRoot } = require(
  path.join(__dirname, '..', 'lib', 'lock-store')
);
const { parseArgs } = require(path.join(__dirname, '..', 'lib', 'cli'));
const { buildEntries } = require(path.join(__dirname, '..', 'lib', 'guard'));

const args = parseArgs(process.argv);
const stores = discoverStores(args.cwd);
const baseDir = getRepoRoot(args.cwd);

if (stores.length === 0) {
  if (args.json) {
    console.log('[]');
  } else {
    console.log('No heimdall stores found. Run /heimdall:install to create one.');
  }
  process.exit(0);
}

const report = stores.map((store) => {
  const cfg = readConfig(store.dir) || { locks: [] };
  return {
    kind: store.kind,
    dir: store.dir,
    locks: cfg.locks.map((lock) => ({
      unlockPhrase: lock.unlockPhrase,
      protect: lock.protect || [],
      resolved: buildEntries([lock], baseDir).map((e) => ({
        path: e.dir,
        type: e.isFile ? 'file' : 'dir',
      })),
    })),
  };
});

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

for (const store of report) {
  const lockCount = store.locks.length;
  const lockSuffix = `(${lockCount} lock${lockCount === 1 ? '' : 's'})`;
  console.log(`\n# ${store.kind} store — ${store.dir} ${lockSuffix}`);
  if (lockCount === 0) {
    console.log('  (no lock blocks)');
    continue;
  }
  for (const lock of store.locks) {
    console.log(`  • unlock: "${lock.unlockPhrase}"`);
    for (const r of lock.resolved) {
      console.log(`      [${r.type}] ${r.path}`);
    }
  }
}
console.log();
