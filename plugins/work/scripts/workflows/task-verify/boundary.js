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
  const base = env.BASE_BRANCH || 'main';
  return mergeBase(repoDir, `origin/${base}`, 'HEAD') || mergeBase(repoDir, base, 'HEAD');
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

module.exports = { resolveTaskBaseRef, taskScopeGlobs, observeBoundary };
