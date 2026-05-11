#!/usr/bin/env node

/**
 * mark-task-progress.js — Update tasks.md checkboxes based on TDD phase state.
 *
 * Reads TDD evidence for each task and updates deliverable checkboxes:
 *   [ ]  not started (no TDD state)
 *   [-]  in progress (TDD initialized or partial evidence)
 *   [x]  completed   (full TDD evidence: red + green recorded)
 *   [v]  verified    (completion-checker confirmed deliverables)
 *
 * Usage: node mark-task-progress.js <TASKS_DIR>
 * Called automatically by implement-gate.js on task-advance.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Read TDD phase state for a task.
 * @param {string} tasksDir - Path to ticket tasks directory
 * @param {number} taskNum - 1-indexed task number
 * @returns {'completed'|'in_progress'|'not_started'}
 */
function getTaskStatus(tasksDir, taskNum) {
  const taskDir = path.join(tasksDir, `task${taskNum}`);
  const tddPath = path.join(taskDir, 'tdd-phase.json');

  // Check task type — test/checkpoint tasks complete with RED-only evidence
  const taskType = resolveTaskType(tasksDir, taskNum);
  const isTestOnly = taskType === 'test' || taskType === 'checkpoint';

  try {
    const state = JSON.parse(fs.readFileSync(tddPath, 'utf8'));
    const cycles = state.cycles || [];

    // For test/checkpoint tasks, any cycle (even RED-only) means completed
    if (isTestOnly && cycles.length > 0) return 'completed';

    // For other tasks, require RED+GREEN minimum
    const hasCompleteCycle = cycles.some((c) => c.red && c.green);
    if (hasCompleteCycle) return 'completed';
    // Legacy flat format
    const evidence = state.evidence || {};
    if (evidence.red && evidence.green) return 'completed';
    return 'in_progress';
  } catch {
    if (fs.existsSync(taskDir)) return 'in_progress';
    return 'not_started';
  }
}

const { resolveTaskType } = require(path.join(__dirname, 'resolve-task-type'));

/**
 * Map task status to checkbox marker.
 */
function statusToCheckbox(status) {
  switch (status) {
    case 'verified':
      return '[v]';
    case 'completed':
      return '[x]';
    case 'in_progress':
      return '[-]';
    default:
      return '[ ]';
  }
}

/**
 * Update checkboxes in tasks.md content for a specific task number.
 * Only updates lines within that task's section (between ## Task N and next ## Task or ---).
 *
 * @param {string} content - tasks.md content
 * @param {number} taskNum - 1-indexed task number
 * @param {string} checkbox - '[v]', '[x]', '[-]', or '[ ]'
 * @returns {string} - Updated content
 */
function updateTaskCheckboxes(content, taskNum, checkbox) {
  const lines = content.split('\n');
  const taskHeader = new RegExp(`^## Task ${taskNum}\\b`);
  const nextSection = /^## Task \d|^---$/;

  let inSection = false;
  for (let i = 0; i < lines.length; i++) {
    if (taskHeader.test(lines[i])) {
      inSection = true;
      continue;
    }
    if (inSection && nextSection.test(lines[i])) {
      break;
    }
    if (inSection) {
      // Replace checkbox markers: [ ], [-], [x], [v]
      lines[i] = lines[i].replace(/\[([ xv\-])\]/g, checkbox);
    }
  }

  return lines.join('\n');
}

/**
 * Update all task checkboxes in tasks.md based on TDD state.
 * @param {string} tasksDir - Path to ticket tasks directory
 */
function markProgress(tasksDir) {
  const tasksFile = path.join(tasksDir, 'tasks.md');
  if (!fs.existsSync(tasksFile)) return;

  let content = fs.readFileSync(tasksFile, 'utf8');

  // Find all task numbers
  const taskNums = [];
  const taskPattern = /^## Task (\d+)/gm;
  let match;
  while ((match = taskPattern.exec(content)) !== null) {
    taskNums.push(parseInt(match[1], 10));
  }

  for (const num of taskNums) {
    const status = getTaskStatus(tasksDir, num);
    const checkbox = statusToCheckbox(status);
    content = updateTaskCheckboxes(content, num, checkbox);
  }

  fs.writeFileSync(tasksFile, content);
}

/**
 * Mark specific tasks as verified ([v]) in tasks.md.
 * Called after completion-checker confirms deliverables.
 *
 * @param {string} tasksDir - Path to ticket tasks directory
 * @param {number[]} [taskNums] - Task numbers to mark verified. If omitted, marks ALL completed tasks.
 */
function markVerified(tasksDir, taskNums) {
  const tasksFile = path.join(tasksDir, 'tasks.md');
  if (!fs.existsSync(tasksFile)) return;

  let content = fs.readFileSync(tasksFile, 'utf8');

  // If no specific tasks given, find all completed tasks
  if (!taskNums) {
    taskNums = [];
    const taskPattern = /^## Task (\d+)/gm;
    let match;
    while ((match = taskPattern.exec(content)) !== null) {
      const num = parseInt(match[1], 10);
      const status = getTaskStatus(tasksDir, num);
      if (status === 'completed') taskNums.push(num);
    }
  }

  for (const num of taskNums) {
    content = updateTaskCheckboxes(content, num, '[v]');
  }

  fs.writeFileSync(tasksFile, content);
}

// CLI
if (require.main === module) {
  const tasksDir = process.argv[2];
  if (!tasksDir) {
    console.error('Usage: node mark-task-progress.js <TASKS_DIR>');
    process.exit(1);
  }
  markProgress(tasksDir);
  console.log(`Updated checkboxes in ${path.join(tasksDir, 'tasks.md')}`);
}

module.exports = { markProgress, markVerified, getTaskStatus, updateTaskCheckboxes };
