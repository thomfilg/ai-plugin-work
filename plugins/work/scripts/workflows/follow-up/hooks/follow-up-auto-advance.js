#!/usr/bin/env node

/**
 * follow-up-auto-advance.js — PostToolUse hook for /follow-up.
 * Fail-open: Any error → exit 0 silently.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { runAutoAdvance } = require('../../lib/auto-advance');

// Test seam: an absolute path override lets the surface/blocked test stub
// follow-up-next.js without staging the entire plugin tree. Production code
// never sets FOLLOW_UP_NEXT_PATH; default resolves siblings as before.
const nextPath = process.env.FOLLOW_UP_NEXT_PATH || path.join(__dirname, '..', 'follow-up-next.js');

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

// Surface instructions print their reason just under the opening banner.
// 'surface' is a terminal action handled alongside 'blocked'.
function surfaceReason(instruction) {
  if (instruction.action === 'surface') {
    return `reason: ${(instruction.payload && instruction.payload.reason) || 'unknown'}`;
  }
  return null;
}

if (require.main === module && !process.env.NODE_TEST_CONTEXT) {
  runAutoAdvance({
    workDir: path.join(__dirname, '..', '..', 'work'),
    markerFile: '.follow-up-orchestrator.pid',
    scriptPath: nextPath,
    timeout: 130000, // monitor can take up to 2 min
    banners: BANNERS,
    surfaceExtra: surfaceReason,
    afterInstruction: persistInstruction,
  });
}
