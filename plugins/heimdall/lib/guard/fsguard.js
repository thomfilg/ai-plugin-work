'use strict';

/**
 * Runtime write-guard shim wiring (GH-657).
 *
 * The static scripts-bypass check cannot tell, from a script's text, whether a
 * write targets a protected dir. Instead, when a Bash command runs an external
 * script, the PreToolUse hook REWRITES the command to preload the
 * heimdall-fsguard interposer, which denies (EACCES) any write that resolves
 * under a protected dir at runtime — covering variable/path.join/concat targets
 * and spawned subprocesses. The block is scoped per-command to the entries that
 * are still LOCKED this session, so an unlocked entry is simply omitted (correct
 * per-agent unlock semantics that a uid-level OS boundary could not provide).
 */

const fs = require('node:fs');
const path = require('node:path');
const { extractScriptPaths } = require('../command-analysis');

// node process.arch → `uname -m` token used in the committed artifact name.
const ARCH_MAP = { x64: 'x86_64', arm64: 'aarch64' };

/**
 * Absolute path to the interposer .so for this platform, or null when it can't
 * apply (non-Linux, missing artifact, or the `HEIMDALL_DISABLE_SHIM` operator
 * kill-switch). Null forces the caller back to the static fail-closed check.
 */
function shimPath() {
  if (process.env.HEIMDALL_DISABLE_SHIM) return null;
  if (process.platform !== 'linux') return null;
  const arch = ARCH_MAP[process.arch] || process.arch;
  const so = path.join(
    __dirname,
    '..',
    '..',
    'scripts',
    'bin',
    `heimdall-fsguard.linux-${arch}.so`
  );
  try {
    return fs.existsSync(so) ? so : null;
  } catch {
    return null;
  }
}

/** True when the command invokes an interpreter on a script FILE. */
function runsExternalScript(command) {
  return extractScriptPaths(command).length > 0;
}

// Single-quote a value for POSIX sh (close-quote, escaped quote, reopen).
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** Absolute allowed-subdir paths (entry.dir/<allowed>) across the locked dirs. */
function allowedAbsPaths(lockedDirEntries) {
  const out = [];
  for (const e of lockedDirEntries) {
    for (const sub of e.allowedPaths || []) out.push(path.join(e.dir, sub));
  }
  return out;
}

/**
 * Prepend env exports that preload the interposer and declare the protected /
 * allowed dirs, then the original command. Env does not persist between Bash
 * tool calls, so exporting here scopes it to THIS command while preserving cwd
 * and compound-command semantics (no nested shell). An existing LD_PRELOAD is
 * preserved (our .so is prepended).
 *
 * Recognizable rewrite shape (GH-689 vector 4), always in this order:
 *   1. `SHIM_REWRITE_MARKER` (POSIX no-op, stable across versions);
 *   2. `export LD_PRELOAD='<plugin>/scripts/bin/heimdall-fsguard.linux-<arch>.so'`;
 *   3. `export HEIMDALL_PROTECTED='<dir:dir>'` (+ optional HEIMDALL_ALLOWED);
 *   4. the original command, byte-identical.
 * The interposer only NARROWS permissions (EACCES on writes under the
 * protected dirs), never widens them. Operators whose harness classifiers
 * still veto the rewrite can set HEIMDALL_DISABLE_SHIM=1 to fall back to the
 * static fail-closed script check.
 */
// Stable, classifier-recognizable prefix for the shim rewrite (GH-689 vector
// 4): a POSIX `:` no-op, so prepending it never changes command semantics.
// External harness/auto-mode classifiers that flag LD_PRELOAD exports as
// bypass attempts can recognize this marker as heimdall guard output.
const SHIM_REWRITE_MARKER = ": 'heimdall-fsguard-rewrite-v1';";

function buildShimRewrite(command, lockedDirEntries, so) {
  const protectedCsv = lockedDirEntries.map((e) => e.dir).join(':');
  const allowedCsv = allowedAbsPaths(lockedDirEntries).join(':');
  let pre = `${SHIM_REWRITE_MARKER} `;
  pre += `export LD_PRELOAD=${shQuote(so)}\${LD_PRELOAD:+:$LD_PRELOAD}; `;
  pre += `export HEIMDALL_PROTECTED=${shQuote(protectedCsv)}; `;
  if (allowedCsv) pre += `export HEIMDALL_ALLOWED=${shQuote(allowedCsv)}; `;
  return pre + command;
}

module.exports = {
  shimPath,
  runsExternalScript,
  buildShimRewrite,
  allowedAbsPaths,
  SHIM_REWRITE_MARKER,
};
