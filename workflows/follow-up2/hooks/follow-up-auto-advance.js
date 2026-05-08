#!/usr/bin/env node

/**
 * follow-up-auto-advance.js — PostToolUse hook for /follow-up2.
 * Fail-open: Any error → exit 0 silently.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

function main() {
  let hookData;
  try {
    const input = fs.readFileSync(0, 'utf8');
    hookData = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const transcriptPath = hookData?.transcript_path || '';
  if (transcriptPath.includes('/subagents/')) process.exit(0);

  const { resolvePluginPaths } = require(
    path.join(__dirname, '..', '..', 'work2', 'lib', 'resolve-plugin-root')
  );
  const { libDir } = resolvePluginPaths(path.join(__dirname, '..', '..', 'work2'), 2);
  const getConfig = require(path.join(libDir, 'get-config'));
  const WORKTREES_BASE = getConfig('WORKTREES_BASE') || '';
  const TASKS_BASE =
    getConfig('TASKS_BASE') || (WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '');
  if (!TASKS_BASE) process.exit(0);

  const marker = findActiveMarker(TASKS_BASE);
  if (!marker) process.exit(0);

  const markerAge = Date.now() - new Date(marker.startedAt).getTime();
  if (markerAge > 12 * 60 * 60 * 1000) process.exit(0);

  const nextPath = path.join(__dirname, '..', 'follow-up-next.js');
  let result;
  try {
    result = execFileSync(process.execPath, [nextPath, marker.ticket], {
      encoding: 'utf8',
      timeout: 130000, // monitor can take up to 2 min
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    process.exit(0);
  }

  let instruction;
  try {
    instruction = JSON.parse(result);
  } catch {
    process.exit(0);
  }

  if (instruction.action === 'execute') {
    console.log('\n═══ FOLLOW-UP2: NEXT STEP ═══');
    console.log(JSON.stringify(instruction, null, 2));
    console.log('══════════════════════════════\n');
  } else if (instruction.action === 'complete') {
    console.log('\n═══ FOLLOW-UP2: COMPLETE ═══');
    console.log(JSON.stringify(instruction, null, 2));
    console.log('════════════════════════════\n');
  } else if (instruction.action === 'blocked') {
    console.log('\n═══ FOLLOW-UP2: BLOCKED ═══');
    console.log(JSON.stringify(instruction, null, 2));
    console.log('═══════════════════════════\n');
  }

  process.exit(0);
}

function findActiveMarker(tasksBase) {
  try {
    const entries = fs.readdirSync(tasksBase, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const markerPath = path.join(tasksBase, entry.name, '.follow-up2-orchestrator.pid');
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
