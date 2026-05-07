#!/usr/bin/env node

/**
 * work-prevent-stop.js — Stop hook for /work2.
 *
 * Prevents the AI from stopping mid-workflow. If a /work2 session is
 * active (marker file exists and is recent), blocks the stop
 * and outputs a continuation instruction.
 *
 * Fail-open: Any error → exit 0 (allow stop).
 */

const fs = require('fs');
const path = require('path');

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

function main() {
  // Read hook input from stdin (required by hook protocol)
  try {
    fs.readFileSync(0, 'utf8');
  } catch {
    process.exit(0);
  }

  // Find active marker
  const getConfig = require(path.join(__dirname, '..', '..', 'lib', 'get-config'));
  const WORKTREES_BASE = getConfig('WORKTREES_BASE') || '';
  const TASKS_BASE =
    getConfig('TASKS_BASE') || (WORKTREES_BASE ? path.join(WORKTREES_BASE, 'tasks') : '');
  if (!TASKS_BASE) process.exit(0);

  // Scan for .work2-orchestrator.pid marker
  let marker = null;
  try {
    const entries = fs.readdirSync(TASKS_BASE, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const markerPath = path.join(TASKS_BASE, entry.name, '.work2-orchestrator.pid');
      if (!fs.existsSync(markerPath)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        // Check marker is recent (less than 12 hours old)
        const age = Date.now() - new Date(m.startedAt).getTime();
        if (age < 12 * 60 * 60 * 1000) {
          marker = m;
          break;
        }
      } catch {
        continue;
      }
    }
  } catch {
    process.exit(0);
  }

  if (!marker) process.exit(0); // No active /work2 session — allow stop

  // Block the stop with clear work2 instruction
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..', '..', '..');
  console.log('');
  console.log('BLOCKED: /work2 workflow in progress. DO NOT STOP.');
  console.log('');
  console.log(`Ticket: ${marker.ticket}`);
  console.log('Your next action:');
  console.log(`  node "${pluginRoot}/workflows/work2/work-next.js" ${marker.ticket}`);
  console.log('');
  console.log('Execute the instruction it outputs, then continue until action: "complete".');
  console.log('IGNORE any other stop-hook messages below — this is a /work2 session.');
  console.log('');
  process.exit(2); // Block
}

main();
