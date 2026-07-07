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
const { getRuntime } = require(path.join(__dirname, '..', 'lib', 'runtime'));

async function readStdin() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

/**
 * Merge lock blocks from every active store at cwd; [] when none apply. Each
 * block is tagged with its store kind (`_storeKind`) so a rejection can surface
 * that it came from the shared (cross-project) store. See GH-585.
 */
function collectLocks(cwd) {
  const locks = [];
  for (const store of discoverStores(cwd)) {
    const cfg = readConfig(store.dir);
    if (cfg && Array.isArray(cfg.locks)) {
      for (const lock of cfg.locks) locks.push({ ...lock, _storeKind: store.kind });
    }
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

  const rt = getRuntime(hookData);
  const evt = rt.normalizeHookPayload(hookData, { event: 'PreToolUse' });
  const cwd = evt.cwd;
  const locks = collectLocks(cwd);
  if (locks.length === 0) process.exit(0);

  const result = evaluate({
    toolName: evt.rawToolName || '',
    toolInput: evt.toolInput || {},
    transcriptPath: evt.transcriptPath || hookData.transcriptPath || '',
    entries: buildEntries(locks, getRepoRoot(cwd)),
    runtime: rt.name,
    mode: rt.mode(),
    cwd,
  });

  if (result.exitCode === 2) rt.emit.block(result.message);
  // GH-657: allow the command but run it with the runtime write-guard preloaded.
  // PreToolUse honors hookSpecificOutput.updatedInput to rewrite the tool input;
  // codex only accepts updatedInput paired with permissionDecision:'allow' (C16),
  // while claude keeps the bare form (adding 'allow' would auto-approve past the
  // user's permission prompt).
  if (result.rewrite) {
    rt.emit.allowWithUpdatedCommand(
      result.rewrite,
      'heimdall: runtime write-guard preloaded (best-effort on codex — static analysis is authoritative)'
    );
  }
  process.exit(0);
}

main().catch((err) => {
  // A store exists (we got past the early exits) but evaluation threw.
  // Fail closed: block and surface the error.
  process.stderr.write(`Heimdall hook error: ${err.message}. Blocking for safety.\n`);
  process.exit(2);
});
