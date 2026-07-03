/**
 * Test-command resolution helpers for the implement gate.
 *
 * Resolves the runnable test command for a task from its `### Test Strategy`
 * block (the only supported verification declaration — the legacy
 * `### Test Command` reader was removed in GH-653; generation has rejected
 * that block since GH-651). Shared by the implement gate, the
 * enforce-tdd-on-stop hook, and the task-next.js self-paced runner so all
 * three resolve the SAME command for a task.
 */

'use strict';

const path = require('path');

const ENRICH_DIR = path.join(__dirname, '..');
const { parseTasks } = require(path.join(ENRICH_DIR, '..', 'task-graph'));

// GH-610: Test Strategy → implement-side consumer. These are STABLE APIs
// owned by GH-590; consumed here, never edited.
//   - synthesizeCommand(strategy, envrc): runnable command for
//     unit/integration/e2e/custom kinds; null for citation kinds.
//   - findNearestEnvrc(worktreeDir): worktree-rooted `.envrc` parse (no shell).
//   - parseTasks(tasksDir) from task-parser: exposes `task.testStrategy`.
const { synthesizeCommand } = require(
  path.join(ENRICH_DIR, '..', '..', '..', 'lib', 'test-strategy')
);
const { findNearestEnvrc } = require(
  path.join(ENRICH_DIR, '..', '..', '..', 'lib', 'envrc-resolver')
);
const { parseTasks: parseTasksWithStrategy } = require(path.join(ENRICH_DIR, '..', 'task-parser'));
// (task-parser lives at work/lib/task-parser.js — one level up from enrich dir.)

// Strategy kinds that carry no runnable command — they piggyback on a peer's
// tests via a citation, so `synthesizeCommand` returns null by design (C3).
const CITATION_STRATEGY_KINDS = new Set(['verified-by', 'wiring-citation']);

/** Locate a parsed task by 1-indexed task number. */
function findTaskByNum(tasksDir, taskNum) {
  let tasks;
  try {
    tasks = parseTasksWithStrategy(tasksDir);
  } catch {
    return null;
  }
  if (!Array.isArray(tasks)) return null;
  return tasks.find((t) => t && t.num === Number(taskNum)) || null;
}

/**
 * Read the runnable test command for a specific task from its
 * `### Test Strategy` block, resolving the test-command envelope from the
 * worktree-rooted `.envrc`. Citation kinds (`verified-by` /
 * `wiring-citation`) resolve to `null` by design — they have no command.
 *
 * @param {string} tasksDir
 * @param {number} taskNum - 1-indexed task number
 * @param {string} [worktreeDir] - worktree root used to resolve `.envrc`
 *   for strategy synthesis. Required: without it there is no envelope to
 *   synthesize against, so the resolution is `null`.
 * @returns {string|null}
 */
function readTaskTestCommand(tasksDir, taskNum, worktreeDir) {
  if (!worktreeDir) return null;
  const task = findTaskByNum(tasksDir, taskNum);
  const strategy = task && task.testStrategy;
  if (!strategy) return null;
  if (CITATION_STRATEGY_KINDS.has(strategy.kind)) return null;
  return synthesizeCommand(strategy, findNearestEnvrc(worktreeDir));
}

/**
 * Resolve how a task's tests are executed from its `### Test Strategy`.
 *
 * For citation kinds (`verified-by` / `wiring-citation`) the synthesised
 * `command` is `null` BY DESIGN — that is not a missing command — and the
 * `citation` field carries the strategy object so the caller can defer to
 * the peer task's evidence.
 *
 * Throws a distinct error when a non-citation strategy synthesises to null
 * (e.g. a `custom` kind with neither a command nor a fenced body), so the
 * caller can tell that apart from "no strategy at all".
 *
 * @param {string} tasksDir
 * @param {number} taskNum - 1-indexed task number
 * @param {string} [worktreeDir] - worktree root used to resolve `.envrc`
 * @returns {{ command: string|null, strategyKind: string|null,
 *             citation: object|null, source: 'strategy'|null }}
 */
function resolveTaskTestExecution(tasksDir, taskNum, worktreeDir) {
  if (!worktreeDir) {
    return { command: null, strategyKind: null, citation: null, source: null };
  }

  const task = findTaskByNum(tasksDir, taskNum);
  const strategy = task && task.testStrategy;
  if (!strategy) {
    return { command: null, strategyKind: null, citation: null, source: null };
  }

  const kind = strategy.kind || null;

  // Citation kinds: no runnable command, the citation IS the resolution.
  if (CITATION_STRATEGY_KINDS.has(kind)) {
    return { command: null, strategyKind: kind, citation: strategy, source: 'strategy' };
  }

  const command = synthesizeCommand(strategy, findNearestEnvrc(worktreeDir));
  if (command == null) {
    throw new Error(
      `Task ${taskNum}: Test Strategy synthesis returned null for a non-citation kind=${kind || '<missing>'} ` +
        '(expected a runnable command — check the strategy entry/command body)'
    );
  }
  return { command, strategyKind: kind, citation: null, source: 'strategy' };
}

/**
 * Detect a synthesized/custom command value that leaked from markdown
 * formatting (fenced-block fragment, bare shell name, unmatched backtick).
 * These would `execSync` silently and starve the gate of a real exit code,
 * causing infinite re-dispatch — return a clear block reason instead.
 *
 * @param {string} cmd
 * @returns {string|null} reason if malformed, null if usable
 */
function detectMalformedTestCommand(cmd) {
  const raw = String(cmd || '').trim();
  if (!raw) return 'empty';
  // Bare shell launchers with no arguments — the parser dropped the body
  if (/^(?:bash|sh|zsh|fish|node|python|python3)\s*$/i.test(raw)) return 'bare-interpreter';
  // Pure backtick / fence remnants
  if (/^[`]+$/.test(raw)) return 'backticks-only';
  // Markdown fence opener that survived (must come before the broader
  // stray-backtick check, which would otherwise match first and label
  // ```bash as a "stray-backtick").
  if (/^```/.test(raw)) return 'fence-opener';
  // Starts/ends with a stray backtick (parser failed to strip a partial fence)
  if (/^`/.test(raw) || /`$/.test(raw)) return 'stray-backtick';
  return null;
}

module.exports = {
  CITATION_STRATEGY_KINDS,
  findTaskByNum,
  readTaskTestCommand,
  resolveTaskTestExecution,
  detectMalformedTestCommand,
  parseTasks,
  synthesizeCommand,
  findNearestEnvrc,
};
