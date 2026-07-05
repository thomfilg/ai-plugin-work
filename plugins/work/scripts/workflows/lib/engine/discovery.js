'use strict';

/**
 * lib/engine/discovery.js — workflow discovery + loading for the workflow
 * engine (extracted from workflow-engine.js).
 *
 * Scans plugin workflows/ and global workflows/ for *.workflow.js files
 * (including one level of subdirectories).
 */

const fs = require('fs');
const path = require('path');

// Scan both plugin workflows and global workflows (for non-plugin workflows like create-jira)
const PLUGIN_WORKFLOWS_DIR = path.join(__dirname, '..', '..');
const GLOBAL_WORKFLOWS_DIR = path.join(process.env.HOME || '/home/node', '.claude', 'workflows');

const SKIPPED_DIR_NAMES = new Set(['node_modules', 'lib', '__tests__']);

/** The directory itself plus one level of non-hidden, non-infra subdirectories. */
function listSearchDirs(dir) {
  const searchDirs = [dir];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (SKIPPED_DIR_NAMES.has(entry.name)) continue;
    searchDirs.push(path.join(dir, entry.name));
  }
  return searchDirs;
}

/**
 * Describe one *.workflow.js file for the `list` command.
 * Returns null for non-workflow modules (e.g. CLI-only scripts).
 */
function describeWorkflowFile(searchDir, file) {
  try {
    const wf = require(path.join(searchDir, file));
    if (!wf || !wf.name) return null; // Skip non-workflow modules (e.g. CLI-only scripts)
    return {
      file,
      name: wf.name,
      command: wf.command,
      stateDir: wf.stateDir,
      stepsCount: wf.steps?.length || 0,
    };
  } catch (err) {
    return { file, error: err.message };
  }
}

/** Describe every not-yet-seen *.workflow.js file in one directory. */
function collectWorkflowFiles(searchDir, seen, results) {
  for (const f of fs.readdirSync(searchDir).filter((f) => f.endsWith('.workflow.js'))) {
    if (seen.has(f)) continue; // plugin version takes precedence
    seen.add(f);
    const described = describeWorkflowFile(searchDir, f);
    if (described) results.push(described);
  }
}

/** Scan plugin workflows/ and global workflows/ for *.workflow.js files (including subdirectories) */
function discoverWorkflows() {
  const results = [];
  const seen = new Set();
  for (const dir of [PLUGIN_WORKFLOWS_DIR, GLOBAL_WORKFLOWS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const searchDir of listSearchDirs(dir)) {
      collectWorkflowFiles(searchDir, seen, results);
    }
  }
  return results;
}

/**
 * Locate <name>.workflow.js directly in a base dir or in a subdirectory named
 * after the workflow (e.g. workflows/check/check.workflow.js).
 */
function findWorkflowFile(fileName, name) {
  for (const baseDir of [PLUGIN_WORKFLOWS_DIR, GLOBAL_WORKFLOWS_DIR]) {
    if (!fs.existsSync(baseDir)) continue;
    const directPath = path.join(baseDir, fileName);
    if (fs.existsSync(directPath)) return directPath;
    const subDirPath = path.join(baseDir, name, fileName);
    if (fs.existsSync(subDirPath)) return subDirPath;
  }
  return null;
}

/** Load and validate a workflow module by name */
function loadWorkflow(name) {
  const filePath = findWorkflowFile(`${name}.workflow.js`, name);
  if (!filePath) {
    throw new Error(
      `Workflow "${name}" not found in ${PLUGIN_WORKFLOWS_DIR} or ${GLOBAL_WORKFLOWS_DIR}`
    );
  }
  const wf = require(filePath);

  // Validate required fields
  const required = ['name', 'command', 'stateDir', 'steps', 'transitions'];
  for (const field of required) {
    if (!wf[field]) throw new Error(`Workflow "${name}" missing required field: ${field}`);
  }
  if (!wf.params || typeof wf.params !== 'function') {
    throw new Error(`Workflow "${name}" missing required function: params(args)`);
  }

  return wf;
}

module.exports = { discoverWorkflows, loadWorkflow, PLUGIN_WORKFLOWS_DIR, GLOBAL_WORKFLOWS_DIR };
