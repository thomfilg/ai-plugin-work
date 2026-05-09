/**
 * Task dependency graph resolver.
 *
 * Reads tasks.md and determines which tasks can run in parallel
 * based on their Dependencies and Parallel fields.
 *
 * Returns the set of tasks that are ready to execute given the
 * current completion state.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Parse tasks.md into structured task objects.
 * @param {string} tasksDir
 * @returns {Array<{num: number, title: string, type: string, parallel: boolean, dependencies: number[], completed: boolean}>}
 */
function parseTasks(tasksDir) {
  const tasksPath = path.join(tasksDir, 'tasks.md');
  if (!fs.existsSync(tasksPath)) return [];

  const content = fs.readFileSync(tasksPath, 'utf8');
  const taskBlocks = content.split(/(?=^## Task \d+)/m).filter((b) => /^## Task \d+/.test(b));

  return taskBlocks.map((block) => {
    const numMatch = block.match(/^## Task (\d+)/);
    const num = numMatch ? parseInt(numMatch[1], 10) : 0;

    const titleMatch = block.match(/^## Task \d+\s*[—–-]\s*(.+?)$/m);
    const title = titleMatch ? titleMatch[1].trim() : '';

    const typeMatch = block.match(/### Type\s*\n(\w+)/m);
    const type = typeMatch ? typeMatch[1].trim().toLowerCase() : 'backend';

    const parallelMatch = block.match(/### Parallel\s*\n-?\s*(Yes|No|true|false)/im);
    const parallel = parallelMatch ? /yes|true/i.test(parallelMatch[1]) : false;

    const depsMatch = block.match(/### Dependencies\s*\n-?\s*(.+)/m);
    let dependencies = [];
    if (depsMatch && !/none/i.test(depsMatch[1])) {
      // Parse "Task 1, Task 2" or "Task 1" or "1, 2"
      const nums = depsMatch[1].match(/\d+/g);
      if (nums) dependencies = nums.map(Number);
    }

    // Check completion from checkbox markers
    // [x] = completed, [-] = in progress, [ ] = not started
    const allCheckboxes = block.match(/- \[[ x-]\]/g) || [];
    const completedBoxes = block.match(/- \[x\]/g) || [];
    const completed = allCheckboxes.length > 0 && allCheckboxes.length === completedBoxes.length;

    return { num, title, type, parallel, dependencies, completed };
  });
}

/**
 * Find tasks that are ready to run in parallel.
 *
 * A task is ready when:
 *   1. It is not completed
 *   2. All its dependencies are completed
 *   3. It has Parallel: Yes OR it's the only ready task
 *
 * @param {string} tasksDir
 * @param {number} currentTaskIndex - 0-based index of current task from work state
 * @returns {{parallelTasks: number[], singleTask: number|null}}
 */
function findReadyTasks(tasksDir, currentTaskIndex) {
  const tasks = parseTasks(tasksDir);
  if (tasks.length === 0) return { parallelTasks: [], singleTask: null };

  const completedNums = new Set(tasks.filter((t) => t.completed).map((t) => t.num));
  // Also treat tasks before currentTaskIndex as completed (work state is source of truth)
  const currentTaskNum = currentTaskIndex + 1;
  for (const t of tasks) {
    if (t.num < currentTaskNum) completedNums.add(t.num);
  }

  const ready = tasks.filter((t) => {
    if (completedNums.has(t.num)) return false;
    return t.dependencies.every((dep) => completedNums.has(dep));
  });

  if (ready.length === 0) return { parallelTasks: [], singleTask: null };

  // If multiple ready tasks all have Parallel: Yes, they can run together
  const parallelReady = ready.filter((t) => t.parallel);
  if (parallelReady.length > 1) {
    return { parallelTasks: parallelReady.map((t) => t.num), singleTask: null };
  }

  // Otherwise, run the first ready task sequentially
  return { parallelTasks: [], singleTask: ready[0].num };
}

module.exports = { parseTasks, findReadyTasks };
