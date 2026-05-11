'use strict';

/**
 * Graph validation for task dependency DAGs.
 *
 * Extracted from work-state.js (GH-219). Pure function — no filesystem I/O,
 * no external dependencies. Re-exported by ../work-state.js so all existing
 * consumers are unaffected.
 */

/**
 * @typedef {Object} TaskGraphError
 * @property {string} code
 *   Stable identifier for the violation. One of:
 *   `UNKNOWN_DEPENDENCY`, `SELF_DEPENDENCY`, `DEPENDENCY_CYCLE`,
 *   `DUPLICATE_TASK_NUM`, `INVALID_TASK_GRAPH`, `INVALID_TASK_ENTRY`,
 *   `INVALID_DEPENDENCY_TYPE`.
 *   Used as rule id by preflight.
 * @property {string|null} taskId
 *   Task id (`task_${num}`) the violation belongs to, or null when the input
 *   is not an array / not shaped as a task list.
 * @property {string} message    Human-readable description.
 * @property {string[]} remediation
 *   Actionable fix steps (R18 explainability). Non-empty for every error.
 */

/**
 * @typedef {Object} TaskGraphValidation
 * @property {boolean} valid
 * @property {TaskGraphError[]} errors
 *   All detected violations. Self-dependency errors are reported as
 *   `SELF_DEPENDENCY` (not `DEPENDENCY_CYCLE`) for actionable remediation.
 */

/**
 * Validate a task dependency graph.
 *
 * Pure function — no filesystem I/O. Intended to be shared by:
 *   1. `initTasksMeta` (task-readiness.js) — called BEFORE persisting tasksMeta so
 *      invalid graphs never reach disk (R4).
 *   2. Task 12 preflight in `workflows/lib/preflight.js` — re-runs on every
 *      enforcement decision without duplicating validation logic (see
 *      acceptance criteria: "`validateTaskGraph` exports a stable API for
 *      reuse by Task 12").
 *
 * Accepts an array of task descriptors (from `task-parser.js` `parseTasks`).
 * Each task must have a numeric `num`. A missing `dependencies` field is
 * treated as `[]` (no error) to support legacy / partially-annotated plans.
 *
 * Violations detected:
 *   - `SELF_DEPENDENCY`    — task declares itself as a dependency
 *   - `UNKNOWN_DEPENDENCY` — dependency id has no matching task
 *   - `DEPENDENCY_CYCLE`   — directed cycle in the remaining edges after
 *                             self-edges are stripped (DFS coloring)
 *
 * @param {Array<{num:number, dependencies?:number[]}>} tasks
 * @returns {TaskGraphValidation}
 */
function validateTaskGraph(tasks) {
  if (!Array.isArray(tasks)) {
    return {
      valid: false,
      errors: [
        {
          code: 'INVALID_TASK_GRAPH',
          taskId: null,
          message: `validateTaskGraph expected an array of tasks, received ${tasks === null ? 'null' : typeof tasks}.`,
          remediation: [
            'Pass the result of parseTasks(tasksDir) from task-parser.js.',
            'Verify tasks.md exists and has at least one `## Task N` section.',
          ],
        },
      ],
    };
  }

  const errors = [];

  // Build task-number set and adjacency list in a single pass. Skip tasks
  // whose `num` is not a positive integer — report once but keep going so
  // we can surface every detectable error in one call.
  const taskNums = new Set();
  for (const task of tasks) {
    if (task && Number.isInteger(task.num) && task.num > 0) {
      if (taskNums.has(task.num)) {
        errors.push({
          code: 'DUPLICATE_TASK_NUM',
          taskId: `task_${task.num}`,
          message: `Duplicate task number ${task.num} — each task must have a unique \`num\`.`,
          remediation: [
            `Remove or renumber one of the duplicate \`## Task ${task.num}\` headings in tasks.md.`,
            'Task numbers must be unique positive integers.',
          ],
        });
      }
      taskNums.add(task.num);
    } else {
      errors.push({
        code: 'INVALID_TASK_ENTRY',
        taskId: null,
        message: `Task entry missing a positive integer \`num\` field: ${JSON.stringify(task)}`,
        remediation: [
          'Ensure each `## Task N` heading in tasks.md uses a positive integer.',
          'Re-run `parseTasks(tasksDir)` and inspect the output before passing to validateTaskGraph.',
        ],
      });
    }
  }

  // adj[taskNum] = list of dep task nums (self-edges stripped; self-dep
  // reported separately). Only includes edges where the target exists.
  const adj = new Map();
  for (const task of tasks) {
    if (!task || !Number.isInteger(task.num)) continue;
    const deps = Array.isArray(task.dependencies) ? task.dependencies : [];
    const filteredDeps = [];
    for (const dep of deps) {
      if (!Number.isInteger(dep)) {
        errors.push({
          code: 'INVALID_DEPENDENCY_TYPE',
          taskId: `task_${task.num}`,
          message: `Task ${task.num} has a non-integer dependency: ${JSON.stringify(dep)}`,
          remediation: ['Dependencies must be integer task numbers.'],
        });
        continue;
      }
      if (dep === task.num) {
        errors.push({
          code: 'SELF_DEPENDENCY',
          taskId: `task_${task.num}`,
          message: `Task ${task.num} depends on itself.`,
          remediation: [
            `Remove the self-reference from Task ${task.num}'s \`### Dependencies\` section in tasks.md.`,
            'A task cannot wait for its own completion.',
          ],
        });
        continue; // strip from adjacency — don't double-report as cycle
      }
      if (!taskNums.has(dep)) {
        errors.push({
          code: 'UNKNOWN_DEPENDENCY',
          taskId: `task_${task.num}`,
          message: `Task ${task.num} depends on unknown Task ${dep}.`,
          remediation: [
            `Verify Task ${dep} exists in tasks.md under a \`## Task ${dep}\` heading.`,
            `Update Task ${task.num}'s \`### Dependencies\` section to reference an existing task id.`,
          ],
        });
        continue; // unknown edge cannot participate in cycle detection
      }
      filteredDeps.push(dep);
    }
    adj.set(task.num, filteredDeps);
  }

  // Cycle detection via DFS coloring (WHITE/GRAY/BLACK). A GRAY back-edge
  // indicates a cycle; we reconstruct the cycle from the DFS path and dedupe
  // on sorted node set so A→B→A and B→A→B report once.
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  for (const num of taskNums) color.set(num, WHITE);

  const reportedCycles = new Set();

  function dfs(start) {
    // Iterative DFS with explicit path tracking; avoids recursion depth limits
    // on large graphs while preserving the back-edge detection semantics.
    const stack = [{ node: start, depIndex: 0 }];
    const pathArr = [];
    color.set(start, GRAY);
    pathArr.push(start);

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const neighbors = adj.get(frame.node) || [];
      if (frame.depIndex < neighbors.length) {
        const next = neighbors[frame.depIndex++];
        const c = color.get(next);
        if (c === GRAY) {
          // Back-edge → cycle. Extract cycle from path and dedupe.
          const startIdx = pathArr.indexOf(next);
          const cycle = pathArr.slice(startIdx);
          const cycleKey = [...cycle].sort((a, b) => a - b).join(',');
          if (!reportedCycles.has(cycleKey)) {
            reportedCycles.add(cycleKey);
            const display = [...cycle, next].map((n) => `Task ${n}`).join(' → ');
            errors.push({
              code: 'DEPENDENCY_CYCLE',
              taskId: `task_${next}`,
              message: `Dependency cycle detected: ${display}.`,
              remediation: [
                'Break the cycle by removing one dependency edge in tasks.md.',
                `Review the \`### Dependencies\` section of each task in the cycle (${cycle
                  .map((n) => `Task ${n}`)
                  .join(', ')}).`,
                'Tasks in a cycle can never start — at least one must drop its back-reference.',
              ],
            });
          }
        } else if (c === WHITE) {
          color.set(next, GRAY);
          pathArr.push(next);
          stack.push({ node: next, depIndex: 0 });
        }
        // BLACK: fully explored subtree — safe to skip (no new cycles reachable)
      } else {
        color.set(frame.node, BLACK);
        pathArr.pop();
        stack.pop();
      }
    }
  }

  for (const num of taskNums) {
    if (color.get(num) === WHITE) {
      dfs(num);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

module.exports = { validateTaskGraph };
