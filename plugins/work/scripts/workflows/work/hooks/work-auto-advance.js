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

const path = require('path');
const { execFileSync } = require('child_process');
const { installFailOpen, readHookData, normalizePostToolEvent, findRecentWorkMarker } = require(
  path.join(__dirname, '..', 'lib', 'hook-common')
);

installFailOpen();

// Bridge runtime identity to the work-next child (and any libs reading env):
// codex hook processes carry neither CLAUDE_CODE_SESSION_ID nor a runtime
// pin, so children would misclassify without this.
function bridgeRuntimeEnv(rt, evt) {
  if (!process.env.AGENT_RUNTIME) process.env.AGENT_RUNTIME = rt.name;
  if (!process.env.AGENT_SESSION_ID && evt.sessionId) {
    process.env.AGENT_SESSION_ID = evt.sessionId;
  }
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
  if (!hookData) process.exit(0);

  const { rt, evt } = normalizePostToolEvent(hookData);

  // Guard: do NOT fire inside sub-agents (would advance state while agent is working)
  if (rt.isSubagentContext(evt)) process.exit(0);

  bridgeRuntimeEnv(rt, evt);

  const found = findRecentWorkMarker();
  if (!found) process.exit(0);

  const instruction = runWorkNext(found.marker);
  emitInstruction(rt, instruction);

  process.exit(0);
}

main();
