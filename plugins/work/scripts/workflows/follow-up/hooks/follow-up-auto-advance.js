#!/usr/bin/env node

/**
 * follow-up-auto-advance.js — PostToolUse hook for /follow-up.
 * Fail-open: Any error → exit 0 silently.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { resolvePluginConfig } = require('../../lib/plugin-config');

process.on('uncaughtException', () => process.exit(0));
process.on('unhandledRejection', () => process.exit(0));

// Parse the PostToolUse hook payload from stdin. Returns null on any error.
function readHookData() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

// Find THIS terminal's .follow-up-orchestrator.pid marker. findActiveMarker
// scopes by owning session id + worktree root so a hook firing in one agent
// never advances another agent's workflow. Returns null when missing or stale.
function findMarker(TASKS_BASE) {
  const { findActiveMarker } = require(path.join(__dirname, '..', '..', 'work', 'lib', 'marker'));
  const marker = findActiveMarker(TASKS_BASE, '.follow-up-orchestrator.pid');
  if (!marker) return null;
  const markerAge = Date.now() - new Date(marker.startedAt).getTime();
  if (markerAge > 12 * 60 * 60 * 1000) return null;
  return marker;
}

// Run the orchestrator for `ticket` and return its parsed instruction, or null.
function runFollowUpNext(ticket) {
  // Test seam: an absolute path override lets the surface/blocked test stub
  // follow-up-next.js without staging the entire plugin tree. Production code
  // never sets FOLLOW_UP_NEXT_PATH; default resolves siblings as before.
  const nextPath =
    process.env.FOLLOW_UP_NEXT_PATH || path.join(__dirname, '..', 'follow-up-next.js');
  try {
    const result = execFileSync(process.execPath, [nextPath, ticket], {
      encoding: 'utf8',
      timeout: 130000, // monitor can take up to 2 min
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(result);
  } catch {
    return null;
  }
}

// Persist the latest instruction so the Stop hook (session-guard) can surface
// it inline when the agent tries to stop. Without this the agent gets only
// "go run follow-up-next.js again" with no context. Fail-open.
function persistInstruction(TASKS_BASE, ticket, instruction) {
  try {
    const instructionPath = path.join(TASKS_BASE, ticket, '.follow-up-next.json');
    if (instruction.action === 'complete') {
      // Clean up so a future run doesn't surface a stale completion blob
      if (fs.existsSync(instructionPath)) fs.unlinkSync(instructionPath);
    } else {
      fs.writeFileSync(instructionPath, JSON.stringify(instruction, null, 2));
    }
  } catch {
    /* fail-open */
  }
}

const BANNERS = {
  execute: ['═══ FOLLOW-UP2: NEXT STEP ═══', '══════════════════════════════'],
  complete: ['═══ FOLLOW-UP2: COMPLETE ═══', '════════════════════════════'],
  blocked: ['═══ FOLLOW-UP2: BLOCKED ═══', '═══════════════════════════'],
  // R13: 'surface' is terminal (same as 'blocked'). The orchestrator emits it
  // when it needs manual user intervention — e.g. infra-stuck after 3 retries.
  surface: ['═══ FOLLOW-UP2: SURFACE ═══', '═══════════════════════════'],
};

function printInstruction(instruction) {
  const banner = BANNERS[instruction.action];
  if (!banner) return;
  console.log('\n' + banner[0]);
  if (instruction.action === 'surface') {
    const reason = (instruction.payload && instruction.payload.reason) || 'unknown';
    console.log(`reason: ${reason}`);
  }
  console.log(JSON.stringify(instruction, null, 2));
  console.log(banner[1] + '\n');
}

function main() {
  const hookData = readHookData();
  if (!hookData) process.exit(0);

  const transcriptPath = hookData?.transcript_path || '';
  if (transcriptPath.includes('/subagents/')) process.exit(0);

  const { TASKS_BASE } = resolvePluginConfig(path.join(__dirname, '..', '..', 'work'));
  if (!TASKS_BASE) process.exit(0);

  const marker = findMarker(TASKS_BASE);
  if (!marker) process.exit(0);

  const instruction = runFollowUpNext(marker.ticket);
  if (!instruction) process.exit(0);

  persistInstruction(TASKS_BASE, marker.ticket, instruction);
  printInstruction(instruction);
  process.exit(0);
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) main();
