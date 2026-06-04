#!/usr/bin/env node
'use strict';

/**
 * Initialize a Heimdall lock store.
 *
 *   node heimdall-init.js --kind=<local|worktree|global|shared> [--cwd=<path>]
 *
 * Creates the store directory and writes a `.heimdall.json` marker holding an
 * (initially empty) `locks` array. The marker is what makes the store
 * discoverable by the hook — heimdall only enforces locks from marked stores.
 *
 * Idempotent: re-running on an existing store preserves its locks and only
 * refreshes the marker metadata.
 */

const path = require('node:path');
const { parseArgs } = require(path.join(__dirname, '..', 'lib', 'cli'));
const {
  MARKER,
  SCHEMA_VERSION,
  getProjectName,
  candidateStores,
  readConfig,
  writeConfig,
} = require(path.join(__dirname, '..', 'lib', 'lock-store'));

const args = parseArgs(process.argv);
const kind = args.kind || 'local';
const projectName = getProjectName(args.cwd);
const target = candidateStores(args.cwd, projectName).find((c) => c.kind === kind);

if (!target) {
  console.error(`unknown kind: ${kind} (use local|worktree|global|shared)`);
  process.exit(1);
}

const existing = readConfig(target.dir);
const cfg = {
  schemaVersion: SCHEMA_VERSION,
  kind,
  // The shared store is cross-project, so the marker must not embed a real
  // project name (synapsys parity + GH-541 spec §Data Model). All other
  // kinds keep the resolved project name so list/scan can show provenance.
  projectName: kind === 'shared' ? null : projectName,
  createdAt: existing?.createdAt || new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  locks: existing?.locks || [],
};
writeConfig(target.dir, cfg);

console.log(
  `initialized heimdall store at ${path.join(target.dir, MARKER)} ` +
    `(kind=${kind}, project=${cfg.projectName ?? '<none>'}, locks=${cfg.locks.length})`
);
