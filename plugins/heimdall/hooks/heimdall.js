#!/usr/bin/env node
'use strict';

/**
 * Heimdall PreToolUse dispatcher.
 *
 * Reads the hook payload from stdin, discovers active lock stores (local /
 * worktree / global), builds guard entries from their lock blocks, and asks
 * the engine whether the tool call should be blocked.
 *
 * Fail-closed on its OWN errors only when a lock store exists — otherwise
 * fail-open, so installing the plugin without configuring any locks never
 * bricks normal work.
 */

const path = require('node:path');
const { discoverStores, readConfig, getRepoRoot } = require(
  path.join(__dirname, '..', 'lib', 'lock-store')
);
const { buildEntries, evaluate } = require(path.join(__dirname, '..', 'lib', 'guard'));

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

/** Merge lock blocks from every active store at cwd; '' when none apply. */
function collectLocks(cwd) {
  const locks = [];
  for (const store of discoverStores(cwd)) {
    const cfg = readConfig(store.dir);
    if (cfg && Array.isArray(cfg.locks)) locks.push(...cfg.locks);
  }
  return locks;
}

async function main() {
  const raw = await readStdin();

  let hookData;
  try {
    hookData = JSON.parse(raw);
  } catch {
    // Can't parse payload → nothing to enforce against. Allow.
    process.exit(0);
  }

  const cwd = hookData.cwd || process.cwd();
  const locks = collectLocks(cwd);
  if (locks.length === 0) process.exit(0);

  const result = evaluate({
    toolName: hookData.tool_name || '',
    toolInput: hookData.tool_input || {},
    transcriptPath: hookData.transcript_path || hookData.transcriptPath || '',
    entries: buildEntries(locks, getRepoRoot(cwd)),
  });

  if (result.exitCode === 2) {
    process.stderr.write(result.message);
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  // A store exists (we got past the early exits) but evaluation threw.
  // Fail closed: block and surface the error.
  process.stderr.write(`Heimdall hook error: ${err.message}. Blocking for safety.\n`);
  process.exit(2);
});
