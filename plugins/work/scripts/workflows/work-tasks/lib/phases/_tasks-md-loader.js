'use strict';

/**
 * Shared helpers for tasks-phase validators: read `tasks.md` and produce a
 * uniform missing-file error. Centralized to keep jscpd happy and to give
 * every phase a single source of truth for the "where is tasks.md" lookup.
 */

const fs = require('node:fs');
const path = require('node:path');

function readFileSafe(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function tasksMdPath(tasksDir) {
  return path.join(tasksDir, 'tasks.md');
}

/**
 * Read `tasks.md`. On miss, returns a populated `errors` array with the
 * provided template; the caller treats `text === null` as an early-exit signal.
 *
 * @param {string} tasksDir
 * @param {(p:string)=>string} missingMsg builder for the missing-file message
 * @returns {{ text: string|null, errors: string[], path: string }}
 */
function loadTasksMd(tasksDir, missingMsg) {
  const p = tasksMdPath(tasksDir);
  const text = readFileSafe(p);
  if (text === null) {
    return { text: null, errors: [missingMsg(p)], path: p };
  }
  return { text, errors: [], path: p };
}

module.exports = {
  readFileSafe,
  tasksMdPath,
  loadTasksMd,
};
