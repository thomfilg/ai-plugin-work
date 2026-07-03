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

const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
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

// GH-657: ensure the runtime write-guard interposer exists for this host. A
// prebuilt linux-x86_64 .so is committed; on other Linux arches build it from
// source (cc). Best-effort and non-fatal — the hook falls back to the static
// fail-closed check when the .so is absent.
ensureFsguardBuilt();

function ensureFsguardBuilt() {
  try {
    if (os.platform() !== 'linux') return;
    const archMap = { x64: 'x86_64', arm64: 'aarch64' };
    const arch = archMap[process.arch] || process.arch;
    const so = path.join(__dirname, 'bin', `heimdall-fsguard.linux-${arch}.so`);
    if (fs.existsSync(so)) return;
    const r = spawnSync('bash', [path.join(__dirname, 'build-fsguard.sh')], { encoding: 'utf8' });
    if (r.status === 0 && fs.existsSync(so)) {
      console.log(`built runtime write-guard: ${so}`);
    } else {
      console.log('note: runtime write-guard not built (no cc?); using static fail-closed fallback');
    }
  } catch {
    /* non-fatal */
  }
}
