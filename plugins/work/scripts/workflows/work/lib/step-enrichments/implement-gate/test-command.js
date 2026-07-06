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
const { synthesizeCommand, detectMalformedTestCommand } = require(
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
 * The `redMode` field threads the task's optional `red-mode:` declaration
 * (GH-570 — `'ablation'` for regression-coverage tasks, else `null`) so
 * callers can adapt their RED-phase guidance without re-parsing tasks.md.
 *
 * @param {string} tasksDir
 * @param {number} taskNum - 1-indexed task number
 * @param {string} [worktreeDir] - worktree root used to resolve `.envrc`
 * @returns {{ command: string|null, strategyKind: string|null,
 *             citation: object|null, source: 'strategy'|null,
 *             redMode: string|null }}
 */
function resolveTaskTestExecution(tasksDir, taskNum, worktreeDir) {
  if (!worktreeDir) {
    return { command: null, strategyKind: null, citation: null, source: null, redMode: null };
  }

  const task = findTaskByNum(tasksDir, taskNum);
  const strategy = task && task.testStrategy;
  if (!strategy) {
    return { command: null, strategyKind: null, citation: null, source: null, redMode: null };
  }

  const kind = strategy.kind || null;
  const redMode = strategy.redMode || null;

  // Citation kinds: no runnable command, the citation IS the resolution.
  if (CITATION_STRATEGY_KINDS.has(kind)) {
    return { command: null, strategyKind: kind, citation: strategy, source: 'strategy', redMode };
  }

  const command = synthesizeCommand(strategy, findNearestEnvrc(worktreeDir));
  if (command == null) {
    throw new Error(
      `Task ${taskNum}: Test Strategy synthesis returned null for a non-citation kind=${kind || '<missing>'} ` +
        '(expected a runnable command — check the strategy entry/command body)'
    );
  }
  return { command, strategyKind: kind, citation: null, source: 'strategy', redMode };
}

// detectMalformedTestCommand moved to lib/test-strategy.js (W12 unification):
// the tasks-phase draft gate now applies the SAME malformed-command trap at
// generation that this gate applies at execution. Re-exported below so
// existing consumers (test-runner.js, tests) keep their import path.

/**
 * W6 / GH-466 — detect an `eval "$VAR"`-shaped envelope command whose env var
 * is unset/empty in the environment it is about to run in. `eval ""` is a
 * successful no-op: it exits 0 instantly with zero output, which the gate
 * previously recorded as authentic GREEN (false GREEN — GH-466). The
 * synthesizer only emits this shape when the `.envrc` declared the var, so an
 * unset var at run time means the run env diverged from the worktree's
 * declared test envelope (missing/moved `.envrc`, or a custom command that
 * hardcodes the eval shape) — refuse to execute instead of no-opping.
 *
 * @param {string} cmd - the resolved test command
 * @param {object} env - the exact env the command would run with
 * @returns {string|null} the unset env var name, or null when runnable
 */
const EVAL_ENVELOPE_RE = /\beval\s+"\$\{?(\w+)\}?"/;
function detectUnsetEnvelopeCommand(cmd, env) {
  const m = EVAL_ENVELOPE_RE.exec(String(cmd || ''));
  if (!m) return null;
  const value = env ? env[m[1]] : undefined;
  if (typeof value === 'string' && value.trim().length > 0) return null;
  return m[1];
}

module.exports = {
  CITATION_STRATEGY_KINDS,
  findTaskByNum,
  readTaskTestCommand,
  resolveTaskTestExecution,
  detectMalformedTestCommand,
  detectUnsetEnvelopeCommand,
  parseTasks,
  synthesizeCommand,
  findNearestEnvrc,
};
