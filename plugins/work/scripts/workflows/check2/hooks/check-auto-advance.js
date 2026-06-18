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

const path = require('path');
const { runAutoAdvance } = require('../../lib/auto-advance');

const BANNERS = {
  execute: ['═══ CHECK2: NEXT STEP ═══', '═════════════════════════'],
  display: ['═══ CHECK2: NEXT STEP ═══', '═════════════════════════'],
  complete: ['═══ CHECK2: COMPLETE ═══', '════════════════════════'],
  blocked: ['═══ CHECK2: BLOCKED ═══', '═══════════════════════'],
};

if (require.main === module) {
  runAutoAdvance({
    workDir: path.join(__dirname, '..', '..', 'work'),
    markerFile: '.check2-orchestrator.pid',
    scriptPath: path.join(__dirname, '..', 'check-next.js'),
    timeout: 25000,
    banners: BANNERS,
  });
}
