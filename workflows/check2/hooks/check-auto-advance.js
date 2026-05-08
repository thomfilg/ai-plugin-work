#!/usr/bin/env node

/**
 * check-auto-advance.js — PostToolUse hook for /check2.
 *
 * After each Task/Skill completion, calls check-next.js
 * to get the next instruction and outputs it for the AI.
 *
 * Fail-open: Any error → exit 0 silently.
 */

'use strict';

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

  // Guard: do NOT fire inside sub-agents
  const transcriptPath = hookData?.transcript_path || '';
  if (transcriptPath.includes('/subagents/')) process.exit(0);

  // Guard: find active /check2 session via marker file
  const { resolvePluginPaths } = require(
    path.join(__dirname, '..', '..', 'work2', 'lib', 'resolve-plugin-root')
  );
  const { libDir } = resolvePluginPaths(path.join(__dirname, '..', '..', 'work2'), 2);
  const getConfig = require(path.join(libDir, 'get-config'));
  const WORKTREES_BASE = getConfig('WORKTREES_BASE') || '';
  const TASKS_BASE =
    getConfig('TASKS_BASE') || (WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '');
  if (!TASKS_BASE) process.exit(0);

  // Scan for .check2-orchestrator.pid marker
  const marker = findActiveMarker(TASKS_BASE);
  if (!marker) process.exit(0);

  // Guard: marker must be recent (less than 12 hours)
  const markerAge = Date.now() - new Date(marker.startedAt).getTime();
  if (markerAge > 12 * 60 * 60 * 1000) process.exit(0);

  // Call check-next.js
  const checkNextPath = path.join(__dirname, '..', 'check-next.js');
  let result;
  try {
    result = execFileSync(process.execPath, [checkNextPath, marker.ticket], {
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

  if (instruction.action === 'execute' || instruction.action === 'display') {
    console.log('');
    console.log('═══ CHECK2: NEXT STEP ═══');
    console.log(JSON.stringify(instruction, null, 2));
    console.log('═════════════════════════');
    console.log('');
  } else if (instruction.action === 'complete') {
    console.log('');
    console.log('═══ CHECK2: COMPLETE ═══');
    console.log(JSON.stringify(instruction, null, 2));
    console.log('════════════════════════');
    console.log('');
  } else if (instruction.action === 'blocked') {
    console.log('');
    console.log('═══ CHECK2: BLOCKED ═══');
    console.log(JSON.stringify(instruction, null, 2));
    console.log('═══════════════════════');
    console.log('');
  }

  process.exit(0);
}

function findActiveMarker(tasksBase) {
  try {
    const entries = fs.readdirSync(tasksBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const markerPath = path.join(tasksBase, entry.name, '.check2-orchestrator.pid');
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
