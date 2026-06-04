#!/usr/bin/env node
/**
 * work-extensions-status — diagnostic command for the /work extension system.
 *
 * Lists every discovered extension in `.claude/work-extensions/` with its
 * load status, declared events, and any load-time error. Output is a JSON
 * array of `ExtensionStatusEntry`:
 *
 *   { file: string, events: string[], loaded: boolean, error?: string }
 *
 * Covers Task 9 acceptance criteria (R7, G10).
 *
 * Usage:
 *   work-extensions-status [--repo-root <path>] [--tasks-dir <path>] [--pretty]
 *
 * Resolution order for repoRoot / tasksDir:
 *   1. Explicit `--repo-root` / `--tasks-dir` CLI flags (used by tests).
 *   2. `findActiveMarker(TASKS_BASE, '.work.pid')` against the configured
 *      TASKS_BASE — derives both from the active marker.
 *
 * Output:
 *   - Default: single-line JSON to stdout (pipe-friendly).
 *   - `--pretty`: 2-space-indented JSON.
 *   - Empty array when no extensions directory exists (R8 backward compat).
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const { initExtensions } = require(path.join(__dirname, '..', 'lib', 'extensions'));

/**
 * Parse `argv` into a flag object. Supports `--key value` and `--flag`.
 * @param {string[]} argv
 * @returns {{repoRoot?: string, tasksDir?: string, pretty: boolean}}
 */
function parseArgs(argv) {
  const out = { pretty: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--pretty') {
      out.pretty = true;
    } else if (arg === '--repo-root' && i + 1 < argv.length) {
      out.repoRoot = argv[++i];
    } else if (arg === '--tasks-dir' && i + 1 < argv.length) {
      out.tasksDir = argv[++i];
    }
  }
  return out;
}

/**
 * Resolve {repoRoot, tasksDir} from CLI flags or via findActiveMarker.
 * Returns null when no marker is active and no flags supplied (no-op exit).
 * @param {{repoRoot?: string, tasksDir?: string}} flags
 * @returns {{repoRoot: string, tasksDir: string} | null}
 */
function resolveFromMarker(flags) {
  const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
  const wt = getConfig('WORKTREES_BASE') || '';
  const TASKS_BASE = getConfig('TASKS_BASE') || (wt && path.join(wt, 'tasks'));
  if (!TASKS_BASE) return null;
  const { findActiveMarker } = require(path.join(__dirname, '..', 'lib', 'marker'));
  const marker = findActiveMarker(TASKS_BASE, '.work.pid');
  if (!marker) return null;
  const tasksDir = locateTasksDir(TASKS_BASE, marker);
  if (!tasksDir) return null;
  return { repoRoot: marker.worktreeRoot || flags.repoRoot || process.cwd(), tasksDir };
}

function resolveContext(flags) {
  if (flags.repoRoot && flags.tasksDir) {
    return { repoRoot: flags.repoRoot, tasksDir: flags.tasksDir };
  }
  try {
    return resolveFromMarker(flags);
  } catch {
    return null;
  }
}

/**
 * Find the tasksDir for the marker by scanning TASKS_BASE for a `.work.pid`
 * whose ticket field matches.
 * @param {string} tasksBase
 * @param {{ticket?: string}} marker
 * @returns {string | null}
 */
function locateTasksDir(tasksBase, marker) {
  try {
    for (const entry of fs.readdirSync(tasksBase, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(tasksBase, entry.name);
      const markerPath = path.join(candidate, '.work.pid');
      if (!fs.existsSync(markerPath)) continue;
      try {
        const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        if (parsed.ticket === marker.ticket) return candidate;
      } catch {
        /* skip corrupt marker */
      }
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Print the status array to stdout.
 * @param {Array<object>} entries
 * @param {boolean} pretty
 */
function emit(entries, pretty) {
  const text = pretty ? JSON.stringify(entries, null, 2) : JSON.stringify(entries);
  process.stdout.write(`${text}\n`);
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  const ctx = resolveContext(flags);
  if (!ctx) {
    // No active marker and no explicit context — emit empty array so
    // downstream consumers always get valid JSON.
    emit([], flags.pretty);
    return;
  }
  const api = initExtensions({ repoRoot: ctx.repoRoot, tasksDir: ctx.tasksDir });
  emit(api.status(), flags.pretty);
}

main();
