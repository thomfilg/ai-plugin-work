'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Read the task type from tasks.md for a given task number.
 * @param {string} tasksDir - Path to the tasks directory
 * @param {number|string} taskNum - Task number (1-based)
 * @returns {string|null} Lowercase task type or null
 */
function resolveTaskType(tasksDir, taskNum) {
  try {
    const content = fs.readFileSync(path.join(tasksDir, 'tasks.md'), 'utf8');
    const match = content.match(
      new RegExp(`## Task ${taskNum}\\b[\\s\\S]*?### Type\\s*\\n(\\w+)`, 'm')
    );
    return match ? match[1].trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

module.exports = { resolveTaskType };
