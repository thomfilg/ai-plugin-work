#!/usr/bin/env node

/**
 * tdd-next.js — No-op shim for /work.
 *
 * The implement-gate (`scripts/workflows/work/lib/step-enrichments/implement-gate.js`)
 * is the single source of truth for TDD evidence. Agents do not record TDD phases.
 *
 * This file is kept as an export shim so any stale code path that still imports
 * `readPhase` keeps working. `buildInstruction` returns a no-op blob to silence
 * legacy callers/sessions that still invoke the CLI.
 */

const path = require('path');
const fs = require('fs');

if (require.main === module) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
}

const { resolvePluginPaths } = require(path.join(__dirname, 'lib', 'resolve-plugin-root'));
const { libDir } = resolvePluginPaths(__dirname);

const getConfig = require(path.join(libDir, 'get-config'));
const TASKS_BASE = getConfig('TASKS_BASE') || '';

/**
 * Read TDD phase state from the JSON file directly. Still used by
 * mark-task-progress.js to determine task completion.
 */
function readPhase(ticketId, taskNum) {
  const taskDir = taskNum ? `task${taskNum}` : '';
  const tddPath = taskDir
    ? path.join(TASKS_BASE, ticketId, taskDir, 'tdd-phase.json')
    : path.join(TASKS_BASE, ticketId, 'tdd-phase.json');
  try {
    return JSON.parse(fs.readFileSync(tddPath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * No-op. Returns a generic blob telling any caller that TDD recipes are gone.
 */
function buildInstruction(_ticketId, _taskNum) {
  return {
    type: 'noop',
    message:
      'TDD phase instructions are disabled. The implement-gate handles evidence automatically — agents do not need to record TDD phases.',
  };
}

function main() {
  console.log(JSON.stringify(buildInstruction(), null, 2));
}

if (require.main === module) main();

module.exports = { buildInstruction, readPhase };
