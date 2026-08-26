'use strict';

/**
 * task-verify/boundary.js — shared boundary resolution for shadow (GH-755)
 * and outcome (GH-756) modes: the task's base ref, its scope entries from
 * the canonical task parser, and the observe+evaluate composition.
 */

const fs = require('fs');
const path = require('path');

const { parseTasks } = require(path.join(__dirname, '..', 'work', 'lib', 'task-parser'));
const { mergeBase, resolveRef } = require('./collect/git-facts');
const { buildObservations } = require('./observe');
const { evaluate } = require('./verdict-engine');

/**
 * Base-branch candidates for the merge-base fallback, in order.
 *
 * An injected BASE_BRANCH wins (the test/caller contract). Otherwise this
 * goes through the canonical resolver — config.getDiffBaseCandidates(), which
 * is BASE_BRANCH → origin/HEAD symbolic-ref → probe(main, dev, master) — the
 * same list the check/code-checker/completion-checker scope diffs use.
 *
 * Hardcoding `main` here was not equivalent: on a dev-based repo BOTH
 * `origin/main` and `main` fail to resolve, resolveTaskBaseRef returns null,
 * and every boundary on the ticket reports a mechanism failure — which the
 * outcome gate advances past with a `runner-unknown` flag. A task can then
 * reach `completed` without the verifier ever having looked at it.
 */
function baseBranchCandidates(repoDir, env) {
  if (env && env.BASE_BRANCH) {
    const bare = String(env.BASE_BRANCH).replace(/^origin\//, '');
    return [`origin/${bare}`, bare];
  }
  try {
    const config = require(path.join(__dirname, '..', 'lib', 'config'));
    const candidates = config.getDiffBaseCandidates({ cwd: repoDir });
    if (Array.isArray(candidates) && candidates.length > 0) return candidates;
  } catch {
    /* fall through to the literal default below */
  }
  return ['origin/main', 'main'];
}

/**
 * The task's base ref: per-task bookkeeping first, merge base as fallback.
 *
 * A `.last-commit-sha` that EXISTS but does not resolve in repoDir is a
 * repo-identity mismatch (the gate is observing a different repository than
 * the one the ticket committed to) — return null so the caller reports a
 * mechanism failure instead of silently measuring a foreign merge-base.
 */
function resolveTaskBaseRef(repoDir, tasksDir, env = process.env) {
  let sha = null;
  try {
    sha = fs.readFileSync(path.join(tasksDir, '.last-commit-sha'), 'utf8').trim();
  } catch {
    /* no per-task bookkeeping — merge-base fallback below */
  }
  if (sha) {
    return resolveRef(repoDir, sha) ? sha : null;
  }
  for (const ref of baseBranchCandidates(repoDir, env)) {
    const base = mergeBase(repoDir, ref, 'HEAD');
    if (base) return base;
  }
  return null;
}

/** Scope entries for task N from the canonical parser; null when unknown. */
function taskScopeGlobs(tasksDir, taskNum) {
  try {
    const tasks = parseTasks(tasksDir);
    const task = (tasks || []).find((t) => t.num === Number(taskNum));
    return task && Array.isArray(task.filesInScope) ? task.filesInScope : null;
  } catch {
    return null;
  }
}

/**
 * Observe one task boundary and evaluate it.
 * @returns {{ observations, result, baseRef } | { error: string }}
 */
function observeBoundary({ repoDir, tasksDir, taskNum, taskType, baseRef, baseWorktreeDir }) {
  const resolvedBase = baseRef || resolveTaskBaseRef(repoDir, tasksDir);
  if (!resolvedBase) {
    return { error: 'no resolvable base ref for the task boundary' };
  }
  const observations = buildObservations({
    repoDir,
    baseRef: resolvedBase,
    scopeGlobs: taskScopeGlobs(tasksDir, taskNum),
    taskKind: taskType,
    // GH-769: thread the task number so the observer resolves the diff from
    // THIS task's attributed commits (a `Work-Task` trailer partitions a
    // parallel wave's shared range). Serial repos (no trailers) fall through
    // to the legacy diff inside buildObservations.
    taskNum,
    baseWorktreeDir:
      baseWorktreeDir || path.join(tasksDir, `.task-verify-base-${path.basename(repoDir)}`),
  });
  return { observations, result: evaluate(observations, taskType), baseRef: resolvedBase };
}

module.exports = { baseBranchCandidates, resolveTaskBaseRef, taskScopeGlobs, observeBoundary };
