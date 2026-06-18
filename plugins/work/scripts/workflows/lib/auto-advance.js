/**
 * Shared runner for the PostToolUse auto-advance hooks
 * (follow-up/hooks/follow-up-auto-advance.js, check2/hooks/check-auto-advance.js).
 *
 * Both hooks do the same thing — install fail-open guards, read the hook
 * payload from stdin, find this terminal's orchestrator pid marker, run the
 * orchestrator for the ticket, and print the returned instruction inside an
 * action-keyed banner. They differ only in marker filename, orchestrator
 * script, timeout, banner text, and (for follow-up) an instruction-persist
 * side effect plus a surface-reason line — all passed in as options. Keeping
 * the flow here once avoids a cross-file duplicate-block.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { resolvePluginConfig } = require('./plugin-config');

// Parse the PostToolUse hook payload from stdin. Returns null on any error.
function readHookData() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

// Find THIS terminal's orchestrator pid marker. findActiveMarker scopes by
// owning session id + worktree root so a hook firing in one agent never
// advances another agent's workflow. Returns null when missing or stale.
function findMarker(TASKS_BASE, markerFile, workLibDir) {
  const { findActiveMarker } = require(path.join(workLibDir, 'marker'));
  const marker = findActiveMarker(TASKS_BASE, markerFile);
  if (!marker) return null;
  const markerAge = Date.now() - new Date(marker.startedAt).getTime();
  if (markerAge > 12 * 60 * 60 * 1000) return null;
  return marker;
}

// Run an orchestrator script for `ticket` and return its parsed instruction, or
// null on any spawn/parse error (fail-open).
function runOrchestrator(scriptPath, ticket, timeout) {
  try {
    const result = execFileSync(process.execPath, [scriptPath, ticket], {
      encoding: 'utf8',
      timeout,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(result);
  } catch {
    return null;
  }
}

// Print an instruction wrapped in its action's banner. `banners` maps an action
// to a [top, bottom] pair; unknown actions print nothing. `extra`, when given,
// returns an optional line inserted after the opening banner (e.g. a surface
// reason).
function printInstruction(instruction, banners, extra) {
  const banner = banners[instruction.action];
  if (!banner) return;
  console.log('\n' + banner[0]);
  if (extra) {
    const line = extra(instruction);
    if (line) console.log(line);
  }
  console.log(JSON.stringify(instruction, null, 2));
  console.log(banner[1] + '\n');
}

/**
 * Drive one auto-advance cycle, then exit 0 (fail-open at every guard).
 *
 * @param {object} opts
 * @param {string} opts.workDir     — path to the plugin's work dir (config + marker lib root)
 * @param {string} opts.markerFile  — orchestrator pid marker filename
 * @param {string} opts.scriptPath  — orchestrator script to run for the ticket
 * @param {number} opts.timeout     — orchestrator spawn timeout (ms)
 * @param {object} opts.banners     — action → [top, bottom] banner map
 * @param {function} [opts.surfaceExtra]     — instruction → optional banner line
 * @param {function} [opts.afterInstruction] — (TASKS_BASE, ticket, instruction) side effect
 */
function runAutoAdvance(opts) {
  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));

  const hookData = readHookData();
  if (!hookData) process.exit(0);

  // Guard: do NOT fire inside sub-agents
  const transcriptPath = hookData?.transcript_path || '';
  if (transcriptPath.includes('/subagents/')) process.exit(0);

  const { TASKS_BASE } = resolvePluginConfig(opts.workDir);
  if (!TASKS_BASE) process.exit(0);

  const marker = findMarker(TASKS_BASE, opts.markerFile, path.join(opts.workDir, 'lib'));
  if (!marker) process.exit(0);

  const instruction = runOrchestrator(opts.scriptPath, marker.ticket, opts.timeout);
  if (!instruction) process.exit(0);

  if (opts.afterInstruction) opts.afterInstruction(TASKS_BASE, marker.ticket, instruction);
  printInstruction(instruction, opts.banners, opts.surfaceExtra);
  process.exit(0);
}

module.exports = { readHookData, findMarker, runOrchestrator, printInstruction, runAutoAdvance };
