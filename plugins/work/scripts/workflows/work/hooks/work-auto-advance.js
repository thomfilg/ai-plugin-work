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

// Read hook input from stdin
function readHookData() {
  try {
    const input = fs.readFileSync(0, 'utf8');
    return JSON.parse(input);
  } catch {
    process.exit(0);
  }
}

// Bridge runtime identity to the work-next child (and any libs reading env):
// codex hook processes carry neither CLAUDE_CODE_SESSION_ID nor a runtime
// pin, so children would misclassify without this.
function bridgeRuntimeEnv(rt, evt) {
  if (!process.env.AGENT_RUNTIME) process.env.AGENT_RUNTIME = rt.name;
  if (!process.env.AGENT_SESSION_ID && evt.sessionId) {
    process.env.AGENT_SESSION_ID = evt.sessionId;
  }
}

// Guard: find this terminal's active /work session marker (recent, owned).
function findRecentMarker() {
  const { resolvePluginConfig } = require(path.join(__dirname, '..', '..', 'lib', 'plugin-config'));
  const { TASKS_BASE } = resolvePluginConfig(path.resolve(__dirname, '..'));
  if (!TASKS_BASE) process.exit(0);

  // Find THIS terminal's .work.pid marker. findActiveMarker scopes by owning
  // session id + worktree root, so a hook firing in one agent never advances
  // another agent's workflow (cross-wiring).
  const { findActiveMarker } = require(path.join(__dirname, '..', 'lib', 'marker'));
  const marker = findActiveMarker(TASKS_BASE, '.work.pid');
  if (!marker) return null;

  // Guard: marker must be recent (less than 12 hours old) to avoid stale sessions
  const markerAge = Date.now() - new Date(marker.startedAt).getTime();
  if (markerAge > 12 * 60 * 60 * 1000) return null;

  return marker;
}

// Call work-next.js. Test seam: an absolute path override lets tests stub
// work-next.js without staging the entire plugin tree. Production code never
// sets WORK_NEXT_PATH; default resolves the sibling as before.
function runWorkNext(marker) {
  const workNextPath = process.env.WORK_NEXT_PATH || path.join(__dirname, '..', 'work-next.js');
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

  // Parse instruction
  try {
    return JSON.parse(result);
  } catch {
    process.exit(0);
  }
}

// Output the instruction for the AI to see. On claude the emitted bytes
// match the previous console.log sequence exactly; on codex the same text
// rides the additionalContext envelope (plain PostToolUse stdout is not
// injected there).
const BANNERS = {
  execute: ['═══ WORK2: NEXT STEP ═══', '════════════════════════'],
  complete: ['═══ WORK2: COMPLETE ═══', '═══════════════════════'],
  blocked: ['═══ WORK2: BLOCKED ═══', '══════════════════════'],
};

function emitInstruction(rt, instruction) {
  const banner = BANNERS[instruction.action];
  if (banner) {
    rt.emit.context(
      'PostToolUse',
      ['', banner[0], JSON.stringify(instruction, null, 2), banner[1], ''].join('\n')
    );
  }
}

function main() {
  const hookData = readHookData();

  const { getRuntime } = require(path.join(__dirname, '..', '..', 'lib', 'runtime'));
  const rt = getRuntime(hookData);
  const evt = rt.normalizeHookPayload(hookData, { event: 'PostToolUse' });

  // Guard: do NOT fire inside sub-agents (would advance state while agent is working)
  if (rt.isSubagentContext(evt)) process.exit(0);

  bridgeRuntimeEnv(rt, evt);

  const marker = findRecentMarker();
  if (!marker) process.exit(0);

  const instruction = runWorkNext(marker);
  emitInstruction(rt, instruction);

  process.exit(0);
}

main();
