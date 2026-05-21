#!/usr/bin/env node

/**
 * work-auto-advance.js — PostToolUse hook for /work.
 *
 * After each Task/Skill completion, this hook:
 * 1. Checks if a /work session is active (marker file exists)
 * 2. Calls work-next.js to get the next instruction
 * 3. Outputs the instruction via console.log() (visible to AI)
 *
 * Fail-open: Any error → exit 0 silently.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

function main() {
  // Read hook input from stdin
  let hookData;
  try {
    const input = fs.readFileSync(0, 'utf8');
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  // Guard: do NOT fire inside sub-agents (would advance state while agent is working)
  const transcriptPath = hookData?.transcript_path || '';
  if (transcriptPath.includes('/subagents/')) process.exit(0);

  // Guard: find active /work session via marker file
  const { resolvePluginPaths } = require(path.join(__dirname, '..', 'lib', 'resolve-plugin-root'));
  const { libDir } = resolvePluginPaths(__dirname, 3);
  const getConfig = require(path.join(libDir, 'get-config'));
  const WORKTREES_BASE = getConfig('WORKTREES_BASE') || '';
  const TASKS_BASE =
    getConfig('TASKS_BASE') || (WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '');
  if (!TASKS_BASE) process.exit(0);

  // Scan for .work-orchestrator.pid marker in TASKS_BASE subdirectories
  const marker = findActiveMarker(TASKS_BASE);
  if (!marker) process.exit(0);

  // Guard: marker must be recent (less than 12 hours old) to avoid stale sessions
  const markerAge = Date.now() - new Date(marker.startedAt).getTime();
  if (markerAge > 12 * 60 * 60 * 1000) process.exit(0);

  // Call work-next.js
  const workNextPath = path.join(__dirname, '..', 'work-next.js');
  let result;
  try {
    result = execFileSync(process.execPath, [workNextPath, marker.ticket], {
      encoding: 'utf8',
      timeout: 25000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    process.exit(0);
  }

  // Parse and output instruction
  let instruction;
  try {
    instruction = JSON.parse(result);
  } catch {
    process.exit(0);
  }

  // Output the instruction for the AI to see
  if (instruction.action === 'execute') {
    console.log('');
    console.log('═══ WORK2: NEXT STEP ═══');
    console.log(JSON.stringify(instruction, null, 2));
    console.log('════════════════════════');
    console.log('');
  } else if (instruction.action === 'complete') {
    console.log('');
    console.log('═══ WORK2: COMPLETE ═══');
    console.log(JSON.stringify(instruction, null, 2));
    console.log('═══════════════════════');
    console.log('');
  } else if (instruction.action === 'blocked') {
    console.log('');
    console.log('═══ WORK2: BLOCKED ═══');
    console.log(JSON.stringify(instruction, null, 2));
    console.log('══════════════════════');
    console.log('');
  }

  process.exit(0);
}

/**
 * Scan TASKS_BASE for an active .work-orchestrator.pid marker.
 * Returns the parsed marker or null.
 */
function findActiveMarker(tasksBase) {
  try {
    const entries = fs.readdirSync(tasksBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const markerPath = path.join(tasksBase, entry.name, '.work-orchestrator.pid');
      if (!fs.existsSync(markerPath)) continue;
      try {
        return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      } catch {
        continue;
      }
    }
  } catch {
    /* fail-open */
  }
  return null;
}

main();
