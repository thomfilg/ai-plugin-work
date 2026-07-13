#!/usr/bin/env node
'use strict';

/**
 * Remove protection from a Heimdall store.
 *
 *   node heimdall-unprotect.js --phrase="edit .claude" [--paths=".claude"] [--kind=<local|worktree|global|shared>] [--cwd=<path>]
 *
 * - With --phrase only: removes the entire lock block for that phrase.
 * - With --phrase + --paths: removes only those paths from the block; the
 *   block is deleted if it becomes empty.
 *
 * Searches all active stores when --kind is omitted, removing from each that
 * contains a matching block. Never deletes the store or its marker.
 */

const path = require('node:path');
const { editContext } = require(path.join(__dirname, '..', 'lib', 'cli'));
const { readConfig, writeConfig, removeLock, SCHEMA_VERSION } = require(
  path.join(__dirname, '..', 'lib', 'lock-store')
);

const { phrase, paths, dirs } = editContext();

function removeFromStore(storeDir) {
  const cfg = readConfig(storeDir);
  if (!cfg) return false;
  const status = removeLock(cfg, phrase, paths);
  if (status === 'missing') return false;

  if (status === 'removed') console.log(`removed lock block "${phrase}" from ${storeDir}`);
  else if (status === 'emptied')
    console.log(`removed paths and emptied block "${phrase}" from ${storeDir}`);
  else {
    const block = cfg.locks.find((l) => (l.unlockPhrase || '').trim() === phrase);
    console.log(
      `removed [${paths.join(', ')}] from "${phrase}"; remaining [${block.protect.join(', ')}] (${storeDir})`
    );
  }
  cfg.schemaVersion = SCHEMA_VERSION;
  cfg.updatedAt = new Date().toISOString();
  writeConfig(storeDir, cfg);
  return true;
}

const changed = dirs.filter(removeFromStore).length;
if (changed === 0) {
  console.error(`no lock block with phrase "${phrase}" found in any store.`);
  process.exit(1);
}
