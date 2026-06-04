#!/usr/bin/env node
'use strict';

/**
 * Add (or extend) a lock block in a Heimdall store.
 *
 *   node heimdall-protect.js --phrase="edit .claude" --paths=".claude,~/.claude" [--kind=local] [--cwd=<path>]
 *
 * A lock block is the tuple { protect: [<dir|file>, ...], unlockPhrase }.
 * If a block with the same unlockPhrase already exists, the new paths are
 * merged into it (de-duplicated). Otherwise a new block is appended.
 *
 * --allowed=<a,b>  optional: subdirs always writable under a protected dir.
 * --trusted=<a,b>  optional: subdirs whose internal scripts are trusted.
 *
 * Requires the store to exist (run /heimdall:install first). Defaults to the
 * highest-precedence active store when --kind is omitted.
 */

const path = require('node:path');
const { splitList, editContext } = require(path.join(__dirname, '..', 'lib', 'cli'));
const { readConfig, writeConfig, upsertLock, SCHEMA_VERSION } = require(
  path.join(__dirname, '..', 'lib', 'lock-store')
);

const { args, phrase, paths, dirs } = editContext();
if (paths.length === 0) {
  console.error('missing --paths');
  process.exit(1);
}
const storeDir = dirs[0];

const cfg = readConfig(storeDir);
if (!cfg) {
  console.error(`store not initialized at ${storeDir} — run /heimdall:install first.`);
  process.exit(1);
}

const saved = upsertLock(cfg, {
  phrase,
  paths,
  allowedPaths: args.allowed ? splitList(args.allowed) : undefined,
  trustedSubdirs: args.trusted ? splitList(args.trusted) : undefined,
});

cfg.schemaVersion = SCHEMA_VERSION;
cfg.updatedAt = new Date().toISOString();
writeConfig(storeDir, cfg);

console.log(
  `protected [${saved.protect.join(', ')}] under phrase "${phrase}" ` +
    `(store: ${storeDir}, ${cfg.locks.length} block(s) total)`
);
