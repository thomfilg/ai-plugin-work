#!/usr/bin/env node

/**
 * install-commit-msg-hook.js — the one-liner migration installer (GH-539, Task 4).
 *
 * Writes a thin, executable `commit-msg` shim into a pre-existing worktree so
 * that git enforces the shared commit-message rules on every real `git commit`
 * with zero subagent dispatch. The shim simply execs the Task 2 validator:
 *
 *   exec node "<plugin>/scripts/workflows/work/hooks/validate-commit-msg.js" "$1"
 *
 * Hooks-directory resolution (R6 / R15):
 *   - When `git config --get core.hooksPath` returns a value, the shim is
 *     written into THAT directory (alongside the existing biome `pre-commit`).
 *   - Otherwise it falls back to `.git/hooks/commit-msg`.
 *   - `core.hooksPath` is NEVER written or cleared, and `pre-commit` is never
 *     touched — the installer only ever writes the `commit-msg` file.
 *
 * Path safety (R15): the target worktree path is rejected if it contains a `..`
 * traversal segment, before any filesystem side effect.
 *
 * Zero runtime dependencies: Node built-ins only.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

/** Absolute path to the Task 2 validator the shim delegates to. */
const VALIDATOR_PATH = path.resolve(__dirname, '..', 'hooks', 'validate-commit-msg.js');

/**
 * Reject an unsafe worktree argument (missing or containing a `..` traversal
 * segment) before any write happens. Throws on rejection; returns the raw path.
 * @param {string|undefined} raw
 * @returns {string}
 */
function assertSafeWorktree(raw) {
  if (!raw) {
    throw new Error('usage: install-commit-msg-hook.js <worktree-path>');
  }
  const segments = raw.split(/[\\/]/);
  if (segments.includes('..')) {
    throw new Error(`Refusing unsafe worktree path containing "..": ${raw}`);
  }
  return raw;
}

/**
 * Read `core.hooksPath` for the worktree, or `null` when unset. Never mutates
 * the value — this is a pure `--get`.
 * @param {string} worktree
 * @returns {string|null}
 */
function readHooksPath(worktree) {
  try {
    const value = execFileSync('git', ['-C', worktree, 'config', '--get', 'core.hooksPath'], {
      encoding: 'utf-8',
    }).trim();
    return value || null;
  } catch {
    // `git config --get` exits non-zero when the key is unset — treat as unset.
    return null;
  }
}

/**
 * Resolve the directory the `commit-msg` shim must be written into: the
 * configured `core.hooksPath` when set (relative paths are anchored at the
 * worktree root), else `<worktree>/.git/hooks`.
 * @param {string} worktree
 * @returns {string}
 */
function resolveHooksDir(worktree) {
  const configured = readHooksPath(worktree);
  if (configured) {
    return path.isAbsolute(configured) ? configured : path.resolve(worktree, configured);
  }
  return path.resolve(worktree, '.git', 'hooks');
}

/**
 * Build the POSIX shim body that execs the validator with git's commit-message
 * file path (`$1`).
 * @returns {string}
 */
function shimBody() {
  return ['#!/bin/sh', `exec node "${VALIDATOR_PATH}" "$1"`, ''].join('\n');
}

/**
 * Install the executable `commit-msg` shim into the worktree.
 * @param {string} worktree
 * @returns {string} the absolute path of the installed shim
 */
function install(worktree) {
  const hooksDir = resolveHooksDir(worktree);
  fs.mkdirSync(hooksDir, { recursive: true });
  const shimPath = path.join(hooksDir, 'commit-msg');
  fs.writeFileSync(shimPath, shimBody());
  fs.chmodSync(shimPath, 0o755);
  return shimPath;
}

/** CLI entry point. */
function main() {
  let worktree;
  try {
    worktree = assertSafeWorktree(process.argv[2]);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
    return;
  }
  const shimPath = install(worktree);
  process.stdout.write(`Installed commit-msg hook: ${shimPath}\n`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { assertSafeWorktree, resolveHooksDir, shimBody, install };
